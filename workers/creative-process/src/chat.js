// ============================================================
// creative-process /chat（チャット機能 P2・2026-08-12）
// ------------------------------------------------------------
// 「相談」を選んだときの STEP3 チャット（AIアシスタント「ヒアリー」）の
// 会話エンジン。仕様の正は `開発/P1_チャット機能_仕様確定.md`。
//
// 設計の骨子（P1確定事項）：
//   - 役割＝「壁打ち」ではなく「新規・改訂・転用のフォーム記入の代行」。
//     会話で要件を聞き取り、フォームへ流し込める記入案（構造化ドラフト）を返す。
//   - ステートレス（論点⑤）＝毎回、会話履歴の全体を受け取り、応答とドラフトを
//     返すだけ。KV・Notion・Driveには書かない。唯一の例外はレート制限カウンタ
//     `chatlimit:<email>:<date>`（1人1日120回・SPEC §6）。
//   - 起票はしない（論点③）＝チャットは /submit を直接叩かない。反映後のフォームから
//     既存の送信ボタン・バリデーション・/submit がそのまま使われる。
//   - 画像はチャットでは受け取らない＝添付は反映後のフォームで行う（§3-7-3）。
//   - ドラフトのキーは /submit のフォームキーと同名（§3-7-6のマッピング表）。
//     値の正規化（事業名18件への完全一致・種別10件・改訂→転用の落とし込み）は
//     Geminiの出力を信用せず、このファイルの normalizeDraft() が最終責任を持つ。
//
// API契約（P4のフロント実装が従う）：
//   POST /chat
//     { idToken,                          … 必須。検証は worker.js のルーターで行う
//       history: [{role:"user"|"model", text}, ...],  … 会話全体。末尾＝依頼者の最新発言
//       draftHint: {category, productType} }          … 任意。直近ドラフトの要点
//                                                       （二段構成ナレッジの出し分けに使う）
//   200: { ok:true, reply, draftReady, draft|null, turns, remaining }
//   400: CHAT_BAD_REQUEST / CHAT_TOO_LONG / CHAT_TOO_MANY_TURNS
//   429: CHAT_LIMIT（1日120回）
//   502: CHAT_UPSTREAM（Gemini通信失敗）
//   ※401系（未ログイン）は worker.js が code:"AUTH" の403を返す（フォーム送信と同一）。
//
// 環境変数：
//   GEMINI_API_KEY （必須・Secret）… Gemini APIキー。
//       登録: cd workers/creative-process && npx wrangler secret put GEMINI_API_KEY
//   GEMINI_MODEL   （任意・Var）… 既定 "gemini-2.5-flash"。P3の品質詰めで差し替え可
//
// システム指示は二段構成（ハンドオフP2の提案を採用）：
//   一段目＝基本人格・フォーム定義・選択肢マスタ・用語集の縮約（毎回・約5,000トークン以内）
//   二段目＝制作物の種別が決まったら、そのカテゴリのヒアリング要点だけを追記
//   （draftHint.productType が来たときのみ足す＝毎リクエストのトークンを最小に保つ）
// ============================================================

// ---- システム指示（Googleドライブの正本から自動生成） ---------------
// 文言の正本＝ CRAZY CREATIVE/04_ツールボックス/creative-process/開発/ヒアリー設定資料/
//              00_ヒアリー_システム指示.md
// 直すときはそのMarkdownを編集し `node tools/build-prompt.mjs` を実行する。
// prompt.generated.js を手で書き換えないこと（次の生成で消える）。
import { SYSTEM_BASE_TEMPLATE, CATEGORY_NOTES } from "./prompt.generated.js";

// ---- 定数（選択肢マスタ） ----------------------------------------
// worker.js と循環importになるため定義を共有せず、ここに再掲する。
// 【重要】worker.js 側（DRIVE_FOLDER_TO_BRAND / DRIVE_TYPE_SHELVES）とのズレは
// unit.test.mjs が検査する。選択肢を変えるときは必ず両方＋テストを直すこと。

// 対象事業・部署（Notion選択肢と完全一致・18件）
const CHAT_BRAND_OPTIONS = [
  "ANV｜アニバに関する制作物",
  "CAREER｜CRAZY CAREERに関する制作物",
  "CCA｜CCA事業に関する制作物",
  "CGM-PSC｜PARKSIDE CAFEに関する制作物",
  "CGM-レストラン｜レストランに関する制作物",
  "CGM-館内｜館内備品等に関する制作物",
  "CGM-婚礼｜婚礼に関する制作物",
  "CRAZY｜自社発信物・全社会議等に関する制作物",
  "CR室｜クリ室の自主企画・外部案件の管理用",
  "CW｜CWブランド全体の婚礼・営業に関する制作物",
  "CWA｜CWAに関する制作物",
  "HR｜ハピネス室・組織開発に関する制作物",
  "IWAI-婚礼｜婚礼に関する制作物",
  "IWAI-館内｜館内備品等に関する制作物",
  "MT-the-Terrace｜the Terraceに関する制作物",
  "MT-婚礼｜婚礼に関する制作物",
  "MT-館内｜館内備品等に関する制作物",
  "その他｜AI推進・BD・食企画・経営企画等に関する制作物",
];

// 制作物の種別（Notion選択肢と完全一致・10件）
const CHAT_PRODUCT_TYPES = [
  "イベント・キャンペーン",
  "スライド・ePDF",
  "バナー・告知画像",
  "LP・WEBサイト",
  "チラシ・ポスター・パネル",
  "リーフレット・パンフレット",
  "看板・サイン",
  "ペーパーアイテム",
  "招待状・紙袋・ノベルティ",
  "その他",
];

// 転用で選べない種別（§3-7-6＝該当時は空欄にして会話で言及する）
const TENYO_EXCLUDED_TYPES = ["イベント・キャンペーン", "その他"];

// 広報チームの企画確認状況（3値のみ・不明なら空欄）
const PR_STATUS_OPTIONS = ["必要なし", "これから", "共有済み"];

const CHAT_CATEGORIES = ["新規", "改訂", "転用", "相談"];

// ---- 制限値（SPEC §3-7-2 / §6） ----------------------------------
const CHAT_MAX_MESSAGE_CHARS = 2000; // 1メッセージの入力上限
const CHAT_WRAPUP_TURNS = 25;        // 往復がここに達したらドラフトを確定して打ち切る
const CHAT_HARD_MAX_TURNS = 40;      // 保険の上限（通常は25で打ち切られるため到達しない）
const CHAT_MAX_HISTORY_ITEMS = 80;   // 受け取る履歴の上限（古い分は切り捨て）
const CHAT_DAILY_LIMIT = 120;        // 1人1日の利用上限（Worker判定・SPEC §6）

// ---- エラー文言（SPEC §6の確定文言。1文字も変えない） --------------
const MSG_TOO_LONG = "メッセージが長すぎます。2,000字以内に分けて送ってください。";
const MSG_LIMIT = "本日のチャット利用上限に達しました。フォームに直接入力してください。";
const MSG_UPSTREAM = "ヒアリーと通信できませんでした。時間をおいてもう一度お試しください。";

// ---- レート制限（chatlimit:<email>:<date>） ----------------------
// 日付はJST。formatDateLabelJST（worker.js）と同じ規則だが、循環importを避けるため再掲。
function chatDateLabelJST(ms) {
  const d = new Date((Number(ms) || 0) + 9 * 60 * 60 * 1000);
  const yy = String(d.getUTCFullYear() % 100).padStart(2, "0");
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return yy + mo + da;
}

function chatLimitKey(email, ms) {
  return "chatlimit:" + String(email || "").trim().toLowerCase() + ":" + chatDateLabelJST(ms);
}

// ---- 入力の検証（純粋関数・テスト対象） ---------------------------
// 戻り値: { ok:true, history, draftHint, wrapUp } または { ok:false, status, error, code }
function validateChatPayload(body) {
  const bad = (status, error, code) => ({ ok: false, status, error, code });
  if (!body || typeof body !== "object" || !Array.isArray(body.history)) {
    return bad(400, "会話データの形式が不正です。", "CHAT_BAD_REQUEST");
  }

  // 整形：role は user/model のみ・text は文字列のみ。空行は落とす。
  const history = body.history
    .map((m) => ({
      role: m && m.role === "model" ? "model" : "user",
      text: m && typeof m.text === "string" ? m.text.trim() : "",
    }))
    .filter((m) => m.text)
    // モデル発言はこちらが生成したものなので上限を緩く、異常長だけ切り詰める
    .map((m) => ({ role: m.role, text: m.text.slice(0, 6000) }))
    .slice(-CHAT_MAX_HISTORY_ITEMS);

  if (!history.length) {
    return bad(400, "メッセージがありません。", "CHAT_BAD_REQUEST");
  }
  const last = history[history.length - 1];
  if (last.role !== "user") {
    return bad(400, "会話データの形式が不正です（末尾が依頼者の発言ではありません）。", "CHAT_BAD_REQUEST");
  }
  // 入力上限は「依頼者の最新発言」に対して判定する（SPEC §6）。
  // 過去のuser発言は送信時に検証済みのため、ここでは保険の切り詰めだけを行う。
  if (last.text.length > CHAT_MAX_MESSAGE_CHARS) {
    return bad(400, MSG_TOO_LONG, "CHAT_TOO_LONG");
  }

  const userTurns = history.filter((m) => m.role === "user").length;
  if (userTurns > CHAT_HARD_MAX_TURNS) {
    return bad(400, "会話が長くなりすぎました。「フォームに反映する」で反映するか、ページを開き直してください。", "CHAT_TOO_MANY_TURNS");
  }

  const hint = body.draftHint && typeof body.draftHint === "object" ? body.draftHint : {};
  return {
    ok: true,
    history,
    draftHint: {
      category: CHAT_CATEGORIES.includes(hint.category) ? hint.category : "",
      productType: typeof hint.productType === "string" ? hint.productType.trim() : "",
    },
    wrapUp: userTurns >= CHAT_WRAPUP_TURNS,
    turns: userTurns,
  };
}

// ---- ドラフトの正規化（§3-7-6・純粋関数・テスト対象） --------------
// Geminiの出力は信用しない。フォームに入る値はすべてここで正規化してから返す。

// 対象事業・部署：18件への完全一致に正規化。略称（｜より前）の一致も救う。判定不能は空欄。
function normalizeBrand(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (CHAT_BRAND_OPTIONS.includes(s)) return s;
  const short = (s.split("｜")[0] || "").trim();
  if (!short) return "";
  return CHAT_BRAND_OPTIONS.find((b) => b.split("｜")[0] === short) || "";
}

// 制作物の種別：10件への完全一致。転用では「イベント・キャンペーン」「その他」を空欄に落とす。
function normalizeProductType(v, category) {
  const s = String(v || "").trim();
  if (!CHAT_PRODUCT_TYPES.includes(s)) return "";
  if (category === "転用" && TENYO_EXCLUDED_TYPES.includes(s)) return "";
  return s;
}

// 広報チームの企画確認状況：3値のみ。不明なら空欄（依頼者が選ぶ）。
function normalizePrStatus(v) {
  const s = String(v || "").trim();
  return PR_STATUS_OPTIONS.includes(s) ? s : "";
}

// sourceUrls：URLらしき文字列のみ残す（§3-7-6）。先頭が反映に使われる。
function normalizeSourceUrls(v) {
  const arr = Array.isArray(v) ? v : typeof v === "string" && v ? [v] : [];
  return arr
    .map((s) => String(s || "").trim())
    .filter((s) => /https?:\/\/\S+/.test(s))
    .slice(0, 5);
}

// schedule：{date:"YYYY-MM-DD", text} に正規化。日付不明の行はdate空でtextのみ。上限20行（§4）。
function normalizeScheduleRows(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((row) => {
      const rawDate = String((row && row.date) || "").trim();
      const text = String((row && row.text) || "").trim().slice(0, 200);
      let date = "";
      const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(rawDate);
      if (m) date = m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
      return { date, text };
    })
    .filter((row) => row.date || row.text)
    .slice(0, 20);
}

const CHAT_FREE_TEXT_KEYS = [
  "purpose", "target", "useDate", "usePlace", "outcome", "afterFeeling", "budget",
  "manuscript", "prototype", "intent", "reviseManuscript", "consultDetail",
];

// ドラフト全体の正規化。null＝ドラフトなし（反映ボタンはdisableのまま）。
function normalizeDraft(raw) {
  if (!raw || typeof raw !== "object") return null;

  const d = {};
  // 依頼種別：4値のみ。不明は既定＝新規（§3-7-5「上記以外」）
  d.category = CHAT_CATEGORIES.includes(raw.category) ? raw.category : "新規";
  d.title = String(raw.title || "").trim().slice(0, 200);
  d.sourceUrls = normalizeSourceUrls(raw.sourceUrls);

  // §3-7-5 整合チェック：改訂なのに親フォルダURLが無い → 転用に落とす
  // （URLの実在・02_案件管理の範囲チェックは従来どおり /submit の送信時判定に任せる）
  if (d.category === "改訂" && !d.sourceUrls.length) d.category = "転用";

  // 対象事業・部署：改訂には設問が無いため反映しない（§3-7-6）
  d.brand = d.category === "改訂" ? "" : normalizeBrand(raw.brand);

  // 制作物の種別：新規・転用のみ。単一選択（先頭1件だけ使う）
  let pt = "";
  if (d.category === "新規" || d.category === "転用") {
    const rawList = Array.isArray(raw.productTypes) ? raw.productTypes : [raw.productTypes];
    pt = normalizeProductType(rawList[0], d.category);
  }
  d.productTypes = pt ? [pt] : [];

  d.prStatus = normalizePrStatus(raw.prStatus);

  for (const key of CHAT_FREE_TEXT_KEYS) {
    d[key] = String(raw[key] || "").trim().slice(0, 2000);
  }
  d.schedule = normalizeScheduleRows(raw.schedule);
  return d;
}

// ---- Gemini 構造化出力スキーマ（抽出呼び出し専用・§3-7-6のマッピング表が土台） ----
// 【2026-08-13 P3で二段呼び出しに変更】長い返答文とdraft全体を1回の構造化出力で
// 同時に生成させると、モデルがdraft側を空にする・意味不明な繰り返し文を生成する
// 事故が3モデル連続で再現した（P3ケース1・2の実測）。会話（テキスト）と抽出（JSON）を
// 分離することで、抽出は「直前の要約から拾うだけ」の簡単なタスクになる。
const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    draftReady: {
      type: "BOOLEAN",
      description: "ヒアリーの最後の発言が記入案の要約を示し【フォームに反映する】を案内していればtrue。",
    },
    draft: {
      type: "OBJECT",
      nullable: true,
      description: "現時点のフォーム記入案。分かった項目だけ埋める。まだ何も無ければnull。",
      properties: {
        category: { type: "STRING", enum: ["新規", "改訂", "転用", "相談"] },
        title: { type: "STRING", description: "依頼タイトル（相談では相談タイトル）。60字以内を推奨。" },
        brand: { type: "STRING", description: "対象事業・部署。18件マスタの文字列に完全一致。改訂では空。" },
        productTypes: { type: "ARRAY", items: { type: "STRING" }, description: "制作物の種別（単一選択＝先頭1件のみ）。" },
        purpose: { type: "STRING" },
        target: { type: "STRING" },
        useDate: { type: "STRING" },
        usePlace: { type: "STRING" },
        outcome: { type: "STRING" },
        afterFeeling: { type: "STRING" },
        budget: { type: "STRING" },
        prStatus: { type: "STRING", description: "必要なし／これから／共有済み のいずれか。不明は空。" },
        manuscript: { type: "STRING" },
        prototype: { type: "STRING" },
        intent: { type: "STRING" },
        sourceUrls: { type: "ARRAY", items: { type: "STRING" }, description: "改訂＝親フォルダURL／転用＝転用元URL。" },
        reviseManuscript: { type: "STRING" },
        consultDetail: { type: "STRING" },
        schedule: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: { date: { type: "STRING", description: "YYYY-MM-DD。不明なら空。" }, text: { type: "STRING" } },
            required: ["text"],
          },
        },
      },
      required: ["category", "title"],
    },
  },
  required: ["draftReady"],
};

// ---- システム指示（一段目＝基本・毎回送る） -----------------------
// 本文は prompt.generated.js（＝ドライブの正本から生成）にある。
// ここでは選択肢マスタ（18件）だけを差し込む。マスタをコード側に残しているのは、
// normalizeDraft() の正規化と不可分で、worker.js との一致をテストが検査しているため。
const SYSTEM_BASE = SYSTEM_BASE_TEMPLATE.replace(
  "{{BRAND_OPTIONS}}",
  CHAT_BRAND_OPTIONS.map((b) => "- " + b).join("\n")
);

// ---- システム指示（二段目＝カテゴリ別の詳細要点） ------------------
// CATEGORY_NOTES も prompt.generated.js からimportしている（上の import 文）。
// 制作物の種別が決まってから、該当する1件だけを基本指示に足す（＝毎回のトークンを抑える二段構成）。

// 往復が上限に達したときの打ち切り指示（§3-7-2＝25往復で確定させる）
const WRAPUP_DIRECTIVE = `
# 【重要】往復数が上限に達しました
今回の応答で必ずヒアリングを打ち切ること。「ここまでの内容で反映しましょう」と伝え、
聞けていない項目は【仮】で埋めるか（未記入でOK）とし、記入案の要約を見せて反映ボタンを案内する。追加の質問はしない。`;

// 今日の日付（JST・YYYY-MM-DD）。モデルは現在日時を知らないため必ず注入する。
// これが無いと「8月20日」を過去の年（例: 2024-08-20）と解釈する事故が起きる（P3実測）。
function chatTodayJST(ms) {
  const d = new Date((Number(ms) || 0) + 9 * 60 * 60 * 1000);
  return (
    d.getUTCFullYear() + "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(d.getUTCDate()).padStart(2, "0")
  );
}

// システム指示を組み立てる（純粋関数・テスト対象）。
// opts = { category, productType, wrapUp, nowMs }
function buildSystemInstruction(opts) {
  const o = opts || {};
  let text = SYSTEM_BASE;
  text += `\n\n# 現在日時\n今日は ${chatTodayJST(o.nowMs || 0)}（日本時間）。日付の解釈（「8月20日」「来週中」等）とスケジュールの逆算は、必ずこれを基準にする。過去の日付を納期にしない。`;
  const note = CATEGORY_NOTES[String(o.productType || "").trim()];
  if (note) text += "\n\n" + note;
  if (o.wrapUp) text += "\n" + WRAPUP_DIRECTIVE;
  return text;
}

// ---- 抽出呼び出し用のシステム指示 ---------------------------------
// 会話全文（＋今回の返答）から、フォーム記入ドラフトだけを取り出す。
// 正規化（18件マスタへの完全一致等）は normalizeDraft() が最終責任を持つため、
// ここでは「会話に無い情報を創作しない」ことを最優先に指示する。
function buildExtractInstruction(nowMs) {
  return `あなたは情報抽出器。制作依頼チャット（依頼者とアシスタント「ヒアリー」）の会話全文から、フォーム記入ドラフトをJSONで出力する。

規則：
- 会話で明示された内容と、ヒアリーが提案して依頼者が了承した内容だけを拾う。**会話に無い情報を創作しない。**
- ヒアリーの最後の発言に記入案の要約があれば、それを最優先の情報源とし、要約の全項目を対応するキーへ**漏れなく**反映する。
- 【仮】の付いた値は【仮】ごとそのまま維持する。要約に無いが会話中に確定した値も拾う。
- 値は簡潔な書き言葉（1〜2文）。**同じ語句を繰り返す文は絶対に書かない。**
- 日付は YYYY-MM-DD。今日=${chatTodayJST(nowMs)}を基準に、過去にならない年で解釈する。
- 会話で触れていない項目は空文字（scheduleは空配列）にする。
- draftReady：ヒアリーの最後の発言が記入案の要約を示し、【フォームに反映する】ボタンを案内していればtrue。それ以外はfalse。
- category：新規＝ゼロから作る／改訂＝既存物の更新かつ元データが02_案件管理の中／転用＝元データをもとに別物を作る・または元データが02_案件管理の外／相談＝何を作るか未定のまま。

キーの対応：title=依頼タイトル／brand=対象事業・部署（下の18件に完全一致）／productTypes=制作物の種別（下の10件から1件）／purpose=依頼背景・課題感／target=ターゲット／useDate=使用開始日／usePlace=使用場所・掲載メディア／outcome=得たい成果／afterFeeling=読後感／budget=予算感／prStatus=広報チームの確認状況（必要なし・これから・共有済み）／manuscript=原稿・素材の状況／prototype=プロトタイプ／intent=プロジェクトへの想い／sourceUrls=元データ・親フォルダのURL／reviseManuscript=修正・差替内容／consultDetail=相談内容／schedule=スケジュール行[{date,text}]

対象事業・部署（brand・この文字列に完全一致）：
${CHAT_BRAND_OPTIONS.map((b) => "- " + b).join("\n")}
制作物の種別（productTypes）：${CHAT_PRODUCT_TYPES.join("／")}`;
}

// ---- Gemini 呼び出し（二段：①会話テキスト → ②ドラフト抽出JSON） ----
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

// 応答待ちの上限。Geminiが応答を返さないままハングする事例があるため必ず打ち切る。
// 超過時は AbortError → 呼び出し元で 502 CHAT_UPSTREAM（依頼者は同じ内容を再送できる）。
// 正常応答は5〜10秒程度（P3実測）。25秒待って返らないものは生成暴走とみなして切る。
const GEMINI_TIMEOUT_MS = 25_000;

// 共通のHTTP呼び出し。生成されたテキスト（partsの連結）を返す。
async function geminiRequest(payload, env) {
  const model = (env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL).trim();
  const res = await fetch(GEMINI_API_BASE + encodeURIComponent(model) + ":generateContent", {
    method: "POST",
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      // キーはヘッダで渡す（URLに載せるとログに残りやすいため）
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Geminiのエラー本文はブラウザに返さない。調査用にコードだけログへ（npx wrangler tail）
    console.error("[chat] Gemini APIエラー:", res.status, (body.error && body.error.status) || "(詳細なし)");
    throw new Error("GEMINI_HTTP_" + res.status);
  }
  const parts = (((body.candidates || [])[0] || {}).content || {}).parts || [];
  const text = parts.map((p) => p.text || "").join("").trim();
  if (!text) throw new Error("GEMINI_EMPTY");
  return text;
}

// ①会話：普通のテキストで返答を生成する（スキーマなし）
async function callGeminiReply(history, systemText, env) {
  return geminiRequest({
    systemInstruction: { parts: [{ text: systemText }] },
    contents: history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    generationConfig: { temperature: 0.4 },
  }, env);
}

// ②抽出：会話全文（今回の返答を含む）からドラフトだけをJSONで取り出す
async function callGeminiExtract(history, replyText, env, nowMs) {
  const transcript = [...history, { role: "model", text: replyText }]
    .map((m) => (m.role === "user" ? "依頼者：" : "ヒアリー：") + m.text)
    .join("\n\n");
  const text = await geminiRequest({
    systemInstruction: { parts: [{ text: buildExtractInstruction(nowMs) }] },
    contents: [{ role: "user", parts: [{ text: transcript }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: GEMINI_RESPONSE_SCHEMA,
    },
  }, env);
  // responseSchema指定時は素のJSONが返るが、保険としてコードフェンスを剥がす
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return JSON.parse(cleaned);
}

// ---- 本体 ---------------------------------------------------------
// worker.js のルーターから呼ばれる。Origin検証・ログイン検証（idToken→actor）は
// ルーター側で済んでいる前提。戻り値 { status, body } をルーターが json() で包む。
async function handleChat(body, actor, env) {
  if (!(env.GEMINI_API_KEY || "").trim()) {
    return { status: 500, body: { error: "サーバー設定が未完了です（GEMINI_API_KEY）" } };
  }

  const v = validateChatPayload(body);
  if (!v.ok) {
    return { status: v.status, body: { error: v.error, code: v.code } };
  }

  // レート制限（1人1日120回・JST日付）。KVカウンタは厳密な原子性を持たないが、
  // 目的は暴走・悪用の天井であり多少の取りこぼしは許容する（請求の天井はGCP側の上限）。
  const limitKey = chatLimitKey(actor.email, Date.now());
  const used = parseInt((await env.REQUESTS.get(limitKey)) || "0", 10) || 0;
  if (used >= CHAT_DAILY_LIMIT) {
    return { status: 429, body: { error: MSG_LIMIT, code: "CHAT_LIMIT" } };
  }
  await env.REQUESTS.put(limitKey, String(used + 1), { expirationTtl: 60 * 60 * 48 });

  const systemText = buildSystemInstruction({
    category: v.draftHint.category,
    productType: v.draftHint.productType,
    wrapUp: v.wrapUp,
    nowMs: Date.now(),
  });

  // ①会話の返答（テキスト）。失敗＝会話が続かないので502で返す
  let reply;
  try {
    reply = String(await callGeminiReply(v.history, systemText, env)).trim();
  } catch (e) {
    console.error("[chat] 応答の生成に失敗:", String((e && e.message) || e));
    return { status: 502, body: { error: MSG_UPSTREAM, code: "CHAT_UPSTREAM" } };
  }
  if (!reply) {
    return { status: 502, body: { error: MSG_UPSTREAM, code: "CHAT_UPSTREAM" } };
  }

  // ②ドラフト抽出（JSON）。失敗しても会話は返す（反映ボタンが活性化しないだけ。
  //   次の発言で再抽出されるため、致命にしない）
  let draft = null;
  let draftReady = false;
  try {
    const out = await callGeminiExtract(v.history, reply, env, Date.now());
    draft = normalizeDraft(out && out.draft);
    draftReady = !!(out && out.draftReady) && !!draft;
  } catch (e) {
    console.error("[chat] ドラフト抽出に失敗（会話は継続）:", String((e && e.message) || e));
  }

  return {
    status: 200,
    body: {
      ok: true,
      reply,
      draftReady,
      draft,
      turns: v.turns,
      remaining: Math.max(0, CHAT_DAILY_LIMIT - used - 1),
    },
  };
}

export {
  handleChat,
  // 純粋関数・定数（unit.test.mjs から参照）
  validateChatPayload,
  normalizeDraft,
  normalizeBrand,
  normalizeProductType,
  normalizePrStatus,
  normalizeSourceUrls,
  normalizeScheduleRows,
  buildSystemInstruction,
  chatTodayJST,
  chatLimitKey,
  chatDateLabelJST,
  CHAT_BRAND_OPTIONS,
  CHAT_PRODUCT_TYPES,
  TENYO_EXCLUDED_TYPES,
  PR_STATUS_OPTIONS,
  CHAT_CATEGORIES,
  CHAT_MAX_MESSAGE_CHARS,
  CHAT_WRAPUP_TURNS,
  CHAT_DAILY_LIMIT,
  GEMINI_RESPONSE_SCHEMA,
  GEMINI_DEFAULT_MODEL,
  MSG_TOO_LONG,
  MSG_LIMIT,
  MSG_UPSTREAM,
};
