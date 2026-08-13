#!/usr/bin/env node
// ============================================================
// ヒアリーのシステム指示ビルダー（2026-08-13）
// ------------------------------------------------------------
// Googleドライブの
//   CRAZY CREATIVE/04_ツールボックス/creative-process/開発/ヒアリー設定資料/
//     00_ヒアリー_システム指示.md          ← ここが【正本（SSOT）】
// を読み、Workerに載るデータファイル
//   workers/creative-process/src/prompt.generated.js
// を生成する。
//
// なぜこの形にしたか（二重管理の解消・2026-08-13）：
//   文言の修正頻度はコードより明らかに高く、直すのはデザイナー本人。
//   Markdownで直せるほうが速い。一方でWorkerは実行時にドライブを読めない
//   （読ませると毎リクエストにDrive APIの遅延と失敗経路が増え、
//     ドライブ側の書きかけがそのまま本番の会話に出てしまう）。
//   そこで「ドライブが正本・コードは生成物」とし、その間をこのスクリプトが埋める。
//
// 使い方（VS Codeのターミナル）：
//   cd ~/メインデータ_GitHub/toolbox/workers/creative-process
//   node tools/build-prompt.mjs
//
// ドライブの場所が違うときは環境変数で渡せる：
//   HEARY_SSOT=/path/to/00_ヒアリー_システム指示.md node tools/build-prompt.mjs
// ============================================================

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../src/prompt.generated.js");

// 既定の探索先（Googleドライブ デスクトップのマウント）。見つからなければ環境変数で指定する。
const DEFAULT_SSOT = join(
  homedir(),
  "Library/CloudStorage/GoogleDrive-yukimiyakawa@crazy.co.jp/共有ドライブ",
  "CRAZY CREATIVE/04_ツールボックス/creative-process/開発/ヒアリー設定資料",
  "00_ヒアリー_システム指示.md"
);

// ---- 正本の場所を解決する（テストからも使う） ----------------------
export function resolveSsotPath() {
  const p = process.env.HEARY_SSOT || DEFAULT_SSOT;
  return existsSync(p) ? p : "";
}

// ---- Markdown → { base, notes } に分解する（純粋関数・テスト対象） --
// マーカーは行まるごと一致のときだけ区切りとして扱う。
// （説明文の中で `<!-- @base -->` と書いても引用符や字下げが付くため誤判定しない）
export function parseSsot(md) {
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  let mode = null;      // null → まだマーカーに到達していない（説明文）
  let key = null;
  const buf = { base: [], notes: new Map() };

  for (const line of lines) {
    if (line === "<!-- @base -->") { mode = "base"; continue; }
    const m = /^<!-- @category:\s*(.+?)\s*-->$/.exec(line);
    if (m) { mode = "note"; key = m[1]; buf.notes.set(key, []); continue; }
    if (mode === "base") buf.base.push(line);
    else if (mode === "note") buf.notes.get(key).push(line);
  }

  if (!buf.base.length) {
    throw new Error(
      "正本に `<!-- @base -->` の行が見つかりません。\n" +
      "この行が基本指示の始まりを示しています。消してしまった場合は、\n" +
      "基本指示（「あなたは「ヒアリー」。」で始まる部分）の直前の行に戻してください。"
    );
  }
  if (!buf.notes.size) {
    throw new Error(
      "正本に `<!-- @category: 制作物の種別 -->` の行が1つも見つかりません。\n" +
      "各カテゴリ別要点の直前に、その種別名で1行ずつ置いてください。"
    );
  }

  const trim = (arr) => arr.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  const notes = {};
  for (const [k, v] of buf.notes) notes[k] = trim(v);
  return { base: trim(buf.base), notes };
}

// ---- 生成物の中身を組み立てる（純粋関数・テスト対象） --------------
export function renderModule({ base, notes }) {
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  const noteEntries = Object.entries(notes)
    .map(([k, v]) => `  ${JSON.stringify(k)}: \`${esc(v)}\`,`)
    .join("\n");

  return `// ============================================================
// 【自動生成ファイル・直接編集しないこと】
// ------------------------------------------------------------
// 正本＝Googleドライブ
//   CRAZY CREATIVE/04_ツールボックス/creative-process/開発/ヒアリー設定資料/
//     00_ヒアリー_システム指示.md
//
// 文言を直すときは上のMarkdownを編集し、次を実行してこのファイルを作り直す：
//   cd workers/creative-process && node tools/build-prompt.mjs
//
// このファイルを手で書き換えても、次の生成で上書きされて消えます。
// （ズレたまま放置されないよう、unit.test.mjs が生成物と正本の一致を検査します）
// ============================================================

// {{BRAND_OPTIONS}} は chat.js が CHAT_BRAND_OPTIONS（18件）で置き換える。
// 選択肢マスタをコード側に残しているのは、正規化処理と不可分で、
// worker.js のDriveフォルダ定義との一致を unit.test.mjs が検査しているため。
const SYSTEM_BASE_TEMPLATE = \`${esc(base)}\`;

const CATEGORY_NOTES = {
${noteEntries}
};

export { SYSTEM_BASE_TEMPLATE, CATEGORY_NOTES };
`;
}

// ---- 実行 -----------------------------------------------------------
function main() {
  const ssot = resolveSsotPath();
  if (!ssot) {
    console.error("正本のMarkdownが見つかりません。");
    console.error("探した場所: " + (process.env.HEARY_SSOT || DEFAULT_SSOT));
    console.error("");
    console.error("Googleドライブ デスクトップが起動しているか確認してください。");
    console.error("場所が違う場合は次のように指定できます:");
    console.error("  HEARY_SSOT=\"/正本までのフルパス\" node tools/build-prompt.mjs");
    process.exit(1);
  }

  const parsed = parseSsot(readFileSync(ssot, "utf8"));
  const before = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  const after = renderModule(parsed);

  writeFileSync(OUT, after, "utf8");

  const cats = Object.keys(parsed.notes);
  console.log("正本: " + ssot);
  console.log("生成: " + OUT);
  console.log("基本指示 " + parsed.base.length + "字 ／ カテゴリ別要点 " + cats.length + "件");
  if (parsed.base.length > 9000) {
    console.log("⚠ 基本指示が9,000字を超えています。毎リクエストに乗るためコストと応答時間が増えます。");
  }
  console.log(before === after ? "→ 変更なし（生成物は最新でした）" : "→ 更新しました");
  if (before !== after) {
    console.log("");
    console.log("次にやること:");
    console.log("  node test/unit.test.mjs   # 全合格を確認");
    console.log("  npx wrangler deploy       # 本番へ反映");
  }
}

// 直接実行されたときだけ書き込む（テストからimportしても副作用が起きない）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
