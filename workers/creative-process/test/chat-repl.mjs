#!/usr/bin/env node
// ============================================================
// creative-process P3 会話品質検証用 ターミナル対話ツール（2026-08-12）
// ------------------------------------------------------------
// 目的：P4のUIを待たずに、ヒアリー（src/chat.js）と実際に会話して
//       システム指示の品質を詰める（開発/NEXT_実装ハンドオフ.md の P3）。
//
// 仕組み：Workerをデプロイせず、src/chat.js の handleChat() を直接呼ぶ。
//   - ログイン検証・Origin検証は通らない（本物の検証は worker.js の担当。
//     ここでは actor を固定のテストユーザーにして会話エンジンだけを回す）
//   - KV（レート制限カウンタ）はメモリ上のスタブ。Cloudflareには一切触れない
//   - Gemini API へは本物のリクエストが飛ぶ（＝APIキーが必要・少額課金が発生）
//
// 使い方（VS Codeのターミナルで）：
//   cd workers/creative-process
//   echo 'GEMINI_API_KEY=ここにキー' > .dev.vars   ← 初回のみ。.gitignore済み
//   node test/chat-repl.mjs
//
// 会話ログは test/p3-logs/ に毎ターン自動保存される（.gitignore済み）。
// そのままCoworkチャットに貼れば、システム指示の修正案をレビューできる。
//
// コマンド：
//   /draft … 現在のドラフト全文（JSON）を表示
//   /reset … 会話をリセットして新しいケースを開始（ログは別ファイルになる）
//   /exit  … 終了（ログは保存済み）
//   /help  … コマンド一覧
//
// モデルの差し替え：.dev.vars に GEMINI_MODEL=gemini-2.5-pro などを追記。
// 動作確認用モック：CHAT_REPL_MOCK=1 node test/chat-repl.mjs（APIを呼ばない）
// ============================================================

import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { handleChat, CHAT_WRAPUP_TURNS, GEMINI_DEFAULT_MODEL } from "../src/chat.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(HERE, "..");
const LOG_DIR = join(HERE, "p3-logs");

// ---- P3の検証ケース（NEXT_実装ハンドオフ.md P3） -------------------
const CASES = [
  "ケース1: アルバイト採用のバナーを作りたい（新規・バナー・HR判定）",
  "ケース2: 去年の営業資料の日付だけ変えたい（改訂・親フォルダURLの案内）",
  "ケース3: 去年のポスターをSNS用画像にしたい（転用）",
  "ケース4: 何を作ればいいか分からない（相談として起票）",
  "ケース5: 非協力的な相手（「おまかせで」を連発）",
];

// ---- .dev.vars の読み込み（KEY=VALUE・#コメント可） -----------------
function loadDevVars() {
  const path = join(WORKER_DIR, ".dev.vars");
  const vars = {};
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i > 0) vars[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return vars;
}

// ---- 動作確認用モック（CHAT_REPL_MOCK=1 のときだけAPIを呼ばない） ----
function installMockFetch() {
  // 二段呼び出し（①会話テキスト→②抽出JSON）を模す。responseSchema の有無で判別する。
  let n = 0;
  globalThis.fetch = async (url, opts) => {
    const isExtract = String((opts && opts.body) || "").includes("responseSchema");
    if (!isExtract) n++;
    const text = isExtract
      ? JSON.stringify({
          draftReady: n >= 3,
          draft: n >= 2 ? { category: "新規", title: "【仮】モックの依頼", brand: "HR｜ハピネス室・組織開発に関する制作物", productTypes: ["バナー・告知画像"] } : null,
        })
      : `（モック応答 ${n}）**ご依頼の内容**を教えてください！`;
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    };
  };
}

// ---- 起動時プリフライト：キーで使えるモデルを実際にAPIへ聞く --------
// 404（モデルが見つからない）の切り分け用。2026年のモデル世代交代（2.5系→3系）で、
// 新しいキー／プロジェクトでは既定モデルが引けないことがあるため、
// 一覧から実在するflash系を自動選択する。
async function listAvailableModels(apiKey) {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
    headers: { "x-goog-api-key": apiKey },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (body.error && (body.error.status + " " + (body.error.message || ""))) || "";
    const err = new Error(`HTTP ${res.status} ${detail}`.trim());
    err.httpStatus = res.status;
    throw err;
  }
  return (body.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => String(m.name || "").replace(/^models\//, ""));
}

// 希望モデルが無いときの代替候補（上から順に探す）
function pickModel(preferred, available) {
  if (available.includes(preferred)) return preferred;
  // gemini-flash-latest は生成暴走・指示無視が観測されたため（P3ケース1・2）、
  // 3系の固定名を先に試す。順番はP3の実測で調整してよい。
  const candidates = [
    "gemini-2.5-flash",
    "gemini-3-flash",
    "gemini-3.6-flash",
    "gemini-3-flash-preview",
    "gemini-flash-latest",
    ...available.filter((m) => /flash/.test(m) && !/preview|exp|image|live|lite|tts|8b/.test(m)).sort().reverse(),
    ...available,
  ];
  return candidates.find((m) => available.includes(m)) || "";
}

// 最小の生成テスト（1トークンの応答を求めるだけ・スキーマなし）。
// 一覧に載っていても generateContent が404を返す事例があるため、
// 「本当に生成できるか」を会話開始前に実弾で確かめる。
async function probeGenerate(apiKey, model, apiVersion) {
  const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "テスト。OKとだけ返して。" }] }],
      generationConfig: { maxOutputTokens: 5 },
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, error: body.error || null };
}

// 生成テストを通るモデルを探す。全滅ならエラー全文を表示して終了。
async function resolveWorkingModel(apiKey, preferred, available) {
  const flashCands = available.filter((m) => /flash/.test(m) && !/preview|exp|image|live|tts|8b/.test(m));
  const tried = [];
  const candidates = [...new Set([preferred, "gemini-2.5-flash", "gemini-3-flash", "gemini-3.6-flash", "gemini-3-flash-preview", "gemini-flash-latest", ...flashCands])].filter((m) => available.includes(m) || m === preferred);
  for (const m of candidates.slice(0, 6)) {
    process.stdout.write(C.dim(`…生成テスト: ${m}\n`));
    const r = await probeGenerate(apiKey, m, "v1beta");
    if (r.ok) return { model: m, apiVersion: "v1beta", tried };
    tried.push({ model: m, apiVersion: "v1beta", status: r.status, error: r.error });
    // v1beta が404のときだけ v1 も試す（APIバージョン差の切り分け）
    if (r.status === 404) {
      const r2 = await probeGenerate(apiKey, m, "v1");
      if (r2.ok) return { model: m, apiVersion: "v1", tried };
      tried.push({ model: m, apiVersion: "v1", status: r2.status, error: r2.error });
    }
  }
  return { model: "", apiVersion: "", tried };
}

// ---- 表示ユーティリティ -------------------------------------------
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

// ドラフトの「埋まっている項目」を1行ずつに整形。prevとの差分に印を付ける。
function draftLines(draft, prev) {
  if (!draft) return [];
  const out = [];
  for (const [k, v] of Object.entries(draft)) {
    const val = Array.isArray(v) ? (k === "schedule" ? v.map((r) => `${r.date || "（日付未定）"} ${r.text}`).join(" ／ ") : v.join("、")) : String(v || "");
    if (!val) continue;
    const before = prev ? (Array.isArray(prev[k]) ? JSON.stringify(prev[k]) : String(prev[k] || "")) : "";
    const now = Array.isArray(v) ? JSON.stringify(v) : String(v);
    const mark = !prev || !before ? "＋" : before !== now ? "→" : "　";
    out.push(`${mark} ${k}: ${val.length > 60 ? val.slice(0, 60) + "…" : val}`);
  }
  return out;
}

function nowStamp() {
  const d = new Date(Date.now() + 9 * 3600 * 1000); // JST
  const p = (n) => String(n).padStart(2, "0");
  return {
    file: `${String(d.getUTCFullYear() % 100).padStart(2, "0")}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`,
    human: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} JST`,
  };
}

// ---- 会話ログ（毎ターン上書き保存＝途中でクラッシュしても残る） ------
function saveLog(state) {
  const lines = [];
  lines.push(`# P3会話ログ — ${state.caseLabel}`);
  lines.push("");
  lines.push(`- 日時: ${state.startedAt} ／ モデル: ${state.model} ／ 往復: ${state.turns} ／ draftReady: ${state.draftReady ? "✅" : "─"}`);
  lines.push("");
  lines.push("## 会話");
  lines.push("");
  for (const m of state.history) {
    lines.push(m.role === "user" ? `**ユウキ**: ${m.text}` : `**ヒアリー**: ${m.text}`);
    lines.push("");
  }
  lines.push("## 最終ドラフト");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(state.lastDraft, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## チェック観点（会話後に手で記入）");
  lines.push("");
  lines.push("- [ ] 追加質問なしにフォームが埋まる内容になっている（P3完了条件）");
  lines.push("- [ ] 同じ質問の繰り返しが起きていない");
  lines.push("- [ ] 【仮】が推測値に正しく付いている（確認済みの値に付いていない）");
  lines.push("- [ ] 事業・部署の候補提示が用語集どおり");
  lines.push("- [ ] 往復数が20を超えていない");
  lines.push("- [ ] 気になった点（自由記入）: ");
  lines.push("");
  writeFileSync(state.logPath, lines.join("\n"), "utf8");
}

// ---- 会話ログからの再開（途中でハング・強制終了しても続きから話せる） ----
function latestLogFile() {
  if (!existsSync(LOG_DIR)) return "";
  const files = readdirSync(LOG_DIR).filter((f) => f.startsWith("P3_") && f.endsWith(".md")).sort();
  return files.length ? join(LOG_DIR, files[files.length - 1]) : "";
}

// saveLog() が書いたMarkdownを履歴・ドラフトに復元する
function parseLogFile(path) {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const caseLabel = (lines[0] || "").replace(/^# P3会話ログ — /, "").trim() || "resumed";
  const history = [];
  let mode = "";
  let cur = null;
  for (const line of lines) {
    if (line === "## 会話") { mode = "conv"; continue; }
    if (line === "## 最終ドラフト") { mode = "draft"; if (cur) history.push(cur); cur = null; continue; }
    if (mode === "conv") {
      const mU = /^\*\*ユウキ\*\*: ?(.*)$/.exec(line);
      const mH = /^\*\*ヒアリー\*\*: ?(.*)$/.exec(line);
      if (mU || mH) {
        if (cur) history.push(cur);
        cur = { role: mU ? "user" : "model", text: (mU || mH)[1] };
      } else if (cur) {
        cur.text += "\n" + line;
      }
    }
  }
  for (const m of history) m.text = m.text.trim();
  const jsonMatch = /## 最終ドラフト\n\n```json\n([\s\S]*?)\n```/.exec(text);
  let lastDraft = null;
  try { lastDraft = jsonMatch ? JSON.parse(jsonMatch[1]) : null; } catch { lastDraft = null; }
  return { caseLabel, history: history.filter((m) => m.text), lastDraft };
}

// ---- メイン --------------------------------------------------------
async function main() {
  const devVars = loadDevVars();
  const mock = !!process.env.CHAT_REPL_MOCK;
  const apiKey = process.env.GEMINI_API_KEY || devVars.GEMINI_API_KEY || (mock ? "mock" : "");
  let model = process.env.GEMINI_MODEL || devVars.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;

  if (!apiKey) {
    console.error(C.red("GEMINI_API_KEY が見つかりません。"));
    console.error("workers/creative-process/.dev.vars に次の1行を書いてください（.gitignore済み・コミットされません）:");
    console.error("  GEMINI_API_KEY=発行したキー");
    process.exit(1);
  }
  // よくある事故：プレースホルダ文言のまま保存している／全角文字が混ざっている。
  // キーは半角英数のはず（AIza… で始まる）。日本語が混ざるとfetchのヘッダで
  // 「Cannot convert argument to a ByteString」エラーになるため、先に止める。
  if (!mock && !/^[\x21-\x7e]+$/.test(apiKey)) {
    console.error(C.red("GEMINI_API_KEY に全角文字が含まれています（プレースホルダのままの可能性）。"));
    console.error("VS Codeで .dev.vars を開き、= の右側を発行した実際のキー（AIza… で始まる半角英数）に置き換えてください:");
    console.error("  code " + join(WORKER_DIR, ".dev.vars"));
    process.exit(1);
  }
  // Gemini APIキーの形式：旧「AIza…」／新「AQ.…」（2026年に新形式へ移行。旧形式は2026年9月廃止予定）
  if (!mock && !apiKey.startsWith("AIza") && !apiKey.startsWith("AQ.")) {
    console.log(C.yellow("⚠ キーが AIza / AQ. のどちらでも始まっていません。Gemini APIのキーか確認してください（そのまま続行します）。"));
  }
  if (mock) installMockFetch();

  // プリフライト：このキーで使えるモデルを確認してから会話を始める
  if (!mock) {
    process.stdout.write(C.dim("…キーとモデルを確認しています\n"));
    let available;
    try {
      available = await listAvailableModels(apiKey);
    } catch (e) {
      console.error(C.red("モデル一覧の取得に失敗しました: " + e.message));
      if (e.httpStatus === 401 || e.httpStatus === 403) {
        console.error("キーの認証で弾かれています。新形式（AQ.）キーの互換問題の可能性があります。");
        console.error("このエラーメッセージをそのままCoworkチャットに貼ってください。切り分けます。");
      } else {
        console.error("ネットワークかAPI側の問題の可能性があります。エラーをそのままCoworkチャットに貼ってください。");
      }
      process.exit(1);
    }
    const flashes = available.filter((m) => /flash/.test(m)).slice(0, 8);
    console.log(C.dim("このキーで使えるflash系モデル: " + (flashes.join(" / ") || "（なし）")));

    // 一覧に載っていても生成が404になる事例があるため、実弾テストで確定させる
    const resolved = await resolveWorkingModel(apiKey, pickModel(model, available) || model, available);
    if (!resolved.model) {
      console.error(C.red("生成テストが全滅しました。試した組み合わせとエラー全文："));
      for (const t of resolved.tried) {
        console.error(`- ${t.model}（${t.apiVersion}）→ HTTP ${t.status}: ${JSON.stringify(t.error)}`);
      }
      console.error(C.yellow("\nこの出力をまるごとCoworkチャットに貼ってください。切り分けます。"));
      process.exit(1);
    }
    if (resolved.apiVersion === "v1") {
      console.error(C.yellow("⚠ v1beta では404、v1 でのみ生成できました。chat.js のAPIバージョン対応が必要です。"));
      console.error(C.yellow("  この画面をCoworkチャットに貼ってください（P3の前に小さなP2修正を入れます）。"));
      process.exit(1);
    }
    if (resolved.model !== model) {
      console.log(C.yellow(`⚠ 「${model}」では生成できないため、「${resolved.model}」を使います。`));
      console.log(C.dim(`  恒久設定するには .dev.vars に GEMINI_MODEL=${resolved.model} を追記。`));
      console.log(C.dim("  ※Worker側も同じ状況のはず＝本番デプロイ時に wrangler.toml の [vars] へ GEMINI_MODEL の追記が必要（P5で反映）。"));
      model = resolved.model;
    } else {
      console.log(C.green(`✓ 生成テストOK: ${model}`));
    }
    if (resolved.tried.length) {
      console.log(C.dim("（参考）失敗した組み合わせ:"));
      for (const t of resolved.tried) {
        const msg = t.error && t.error.message ? t.error.message.slice(0, 160) : JSON.stringify(t.error);
        console.log(C.dim(`  - ${t.model}（${t.apiVersion}）→ HTTP ${t.status}: ${msg}`));
      }
    }
  }

  // KVスタブ（レート制限カウンタ用・メモリのみ）
  const kv = new Map();
  const env = {
    GEMINI_API_KEY: apiKey,
    GEMINI_MODEL: model,
    REQUESTS: {
      get: async (k) => (kv.has(k) ? kv.get(k) : null),
      put: async (k, v) => void kv.set(k, v),
    },
  };
  const actor = { email: "p3-test@crazy.co.jp", name: "P3テスト" };

  mkdirSync(LOG_DIR, { recursive: true });

  // 入力は行キューで受ける（readlineのquestion()は、待ち受け前に届いた行を
  // 取りこぼすことがあるため。貼り付け・パイプ入力でも1行ずつ確実に処理する）
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const lineQueue = [];
  const waiters = [];
  let stdinClosed = false;
  rl.on("line", (l) => {
    const w = waiters.shift();
    if (w) w(l);
    else lineQueue.push(l);
  });
  rl.on("close", () => {
    stdinClosed = true;
    while (waiters.length) waiters.shift()(null);
  });
  // 戻り値 null ＝入力が閉じられた（/exit扱いにする）
  const ask = (prompt) => {
    process.stdout.write(prompt);
    if (lineQueue.length) return Promise.resolve(lineQueue.shift());
    if (stdinClosed) return Promise.resolve(null);
    return new Promise((r) => waiters.push(r));
  };

  console.log(C.bold("\n🎨 CREATIVE PROCESS — P3 会話品質検証（ヒアリーと直接会話）"));
  console.log(C.dim(`モデル: ${model}${mock ? "（モック＝APIは呼びません）" : ""} ／ ログ: test/p3-logs/ に自動保存`));
  console.log(C.dim("コマンド: /draft /reset /exit /help ／ 打ち切り往復数: " + CHAT_WRAPUP_TURNS));
  console.log("\n検証ケース（NEXT_実装ハンドオフ.md P3）:");
  for (const c of CASES) console.log("  " + c);

  let state;
  const newSession = async () => {
    const resumable = latestLogFile();
    const hint = resumable ? "／r=直前の会話を再開" : "";
    const label = ((await ask(`\nケース番号かメモを入力（ログのファイル名に使います。例: 1${hint}）> `)) || "").trim() || "freetest";

    // 「r」＝最新ログから会話を復元して続きから話す
    if (resumable && label.toLowerCase() === "r") {
      const restored = parseLogFile(resumable);
      let pending = "";
      // 末尾が自分の発言のまま（＝応答前に落ちた）なら、その発言は取り下げて再送してもらう
      if (restored.history.length && restored.history[restored.history.length - 1].role === "user") {
        pending = restored.history.pop().text;
      }
      state = {
        caseLabel: restored.caseLabel,
        model,
        startedAt: nowStamp().human,
        history: restored.history,
        lastDraft: restored.lastDraft,
        draftReady: false,
        turns: restored.history.filter((m) => m.role === "user").length,
        logPath: resumable,
      };
      console.log(C.green(`\n▶ 再開: ${state.caseLabel}（${state.turns}往復まで復元）`));
      console.log(C.dim(`ログ: ${state.logPath.replace(WORKER_DIR + "/", "")}`));
      if (state.history.length) {
        const lastModel = [...state.history].reverse().find((m) => m.role === "model");
        if (lastModel) console.log(C.cyan("ヒアリー（直前の発言）") + ": " + lastModel.text + "\n");
      }
      if (pending) console.log(C.yellow(`※未送信だった発言があります。必要ならもう一度送ってください: 「${pending}」\n`));
      return;
    }

    const idx = parseInt(label, 10);
    const caseLabel = idx >= 1 && idx <= 5 ? CASES[idx - 1] : label;
    const stamp = nowStamp();
    state = {
      caseLabel,
      model,
      startedAt: stamp.human,
      history: [],
      lastDraft: null,
      draftReady: false,
      turns: 0,
      logPath: join(LOG_DIR, `P3_${stamp.file}_case${idx >= 1 && idx <= 5 ? idx : "X"}.md`),
    };
    console.log(C.green(`\n▶ ${caseLabel}`));
    console.log(C.dim(`ログ: ${state.logPath.replace(WORKER_DIR + "/", "")}`));
    console.log("会話を始めてください（依頼者になりきって最初のひとことを入力）\n");
  };

  await newSession();

  while (true) {
    const raw = await ask(C.bold("ユウキ> "));
    if (raw === null) break; // 入力が閉じられた（Ctrl+D等）
    const input = raw.trim();
    if (!input) continue;

    if (input === "/exit") break;
    if (input === "/help") {
      console.log(C.dim("/draft=ドラフト全文 /reset=新しいケース /exit=終了"));
      continue;
    }
    if (input === "/draft") {
      console.log(JSON.stringify(state.lastDraft, null, 2));
      continue;
    }
    if (input === "/reset") {
      await newSession();
      continue;
    }
    // 未知のコマンドをヒアリーに誤送信しない（P3実測：「/edit」が会話に流れた）
    if (input.startsWith("/")) {
      console.log(C.yellow("未知のコマンドです。使えるのは /draft /reset /exit /help。ヒアリーに送りたい場合は先頭の / を外してください。"));
      continue;
    }

    state.history.push({ role: "user", text: input });
    const body = {
      history: state.history,
      draftHint: {
        category: state.lastDraft?.category || "",
        productType: state.lastDraft?.productTypes?.[0] || "",
      },
    };

    process.stdout.write(C.dim("…ヒアリーが考えています\n"));
    const callOnce = async () => {
      try {
        return await handleChat(body, actor, env);
      } catch (e) {
        return { status: 502, body: { error: String(e && e.message || e) } };
      }
    };
    let res = await callOnce();
    // 通信失敗（タイムアウト・生成暴走）は1回だけ自動リトライする
    if (res.status === 502) {
      process.stdout.write(C.dim("…通信に失敗したため自動で再試行します\n"));
      await new Promise((r) => setTimeout(r, 1500));
      res = await callOnce();
    }

    if (res.status !== 200) {
      // 失敗した発言は履歴から下げて、同じ内容で再送できるようにする
      state.history.pop();
      console.log(C.red(`[${res.status}] ${res.body.error || "エラー"}${res.body.code ? `（${res.body.code}）` : ""}`));
      continue;
    }

    const prev = state.lastDraft;
    const { reply, draft, draftReady, turns } = res.body;
    state.history.push({ role: "model", text: reply });
    if (draft) state.lastDraft = draft;
    state.draftReady = draftReady;
    state.turns = turns;

    console.log("\n" + C.cyan("ヒアリー") + ": " + reply + "\n");
    const dl = draftLines(draft, prev);
    if (dl.length) {
      console.log(C.dim("┌ draft（＋新規 →変更）"));
      for (const l of dl) console.log(C.dim("│ " + l));
      console.log(C.dim("└"));
    }
    const meta = [`往復 ${turns}/${CHAT_WRAPUP_TURNS}`];
    if (draftReady) meta.push(C.green("draftReady ✅（フォームに反映する＝活性）"));
    if (turns >= 18 && !draftReady) meta.push(C.yellow("⚠ 往復20が品質目安です"));
    console.log(C.dim(meta.join(" ／ ")) + "\n");

    // 【P3検品】要約とdraftの不一致検知：draftReadyなのに必須項目が空なら
    // 「要約にはあるのにdraftに無い」退行の可能性が高い（ケース1・2で実際に発生）
    if (draftReady && state.lastDraft) {
      const d = state.lastDraft;
      const REQUIRED = {
        新規: ["purpose", "target", "useDate", "outcome", "afterFeeling"],
        改訂: ["sourceUrls", "reviseManuscript"],
        転用: ["reviseManuscript"],
        相談: ["consultDetail"],
      };
      const empty = (k) => (Array.isArray(d[k]) ? !d[k].length : !String(d[k] || "").trim());
      const missing = (REQUIRED[d.category] || []).filter(empty);
      if (d.category !== "相談" && empty("schedule")) missing.push("schedule");
      if (missing.length) {
        console.log(C.red(`⚠ 検品NG: draftReadyなのに未記入の必須項目があります → ${missing.join(", ")}`));
        console.log(C.red("  （要約に書かれているのにdraftが空＝反映時に欄が埋まらない。この画面ごとログを貼ってください）\n"));
      } else {
        console.log(C.green("✓ 検品OK: 必須項目はすべてdraftに入っています\n"));
      }
    }

    saveLog(state);
  }

  saveLog(state);
  console.log(C.green(`\nログを保存しました: ${state.logPath}`));
  console.log("このファイルをCoworkチャットに貼れば、システム指示の修正案をレビューできます。");
  rl.close();
}

main().catch((e) => {
  console.error(C.red("予期しないエラー: " + (e && e.stack || e)));
  process.exit(1);
});
