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

// ---- Gemini 構造化出力スキーマ（§3-7-6のマッピング表を土台に定義） ----
const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: {
      type: "STRING",
      description: "依頼者への返答（Markdown可・日本語）。質問は1つだけ。",
    },
    draftReady: {
      type: "BOOLEAN",
      description: "記入案としてドラフトが確定し「フォームに反映する」を案内できる状態ならtrue。",
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
  required: ["reply", "draftReady"],
};

// ---- システム指示（一段目＝基本・毎回送る） -----------------------
// ヒアリー_カスタム指示.md／01_フォーム項目定義書.md／03_社内用語集.md を
// 「記入代行」用に縮約したもの。毎リクエストに乗るため約5,000トークン以内に収める。
const SYSTEM_BASE = `あなたは「ヒアリー」。株式会社CRAZYのクリエイティブ室に所属するディレクターです。
社内の依頼者と会話しながら、制作依頼フォーム「CREATIVE PROCESS」の記入を代行します。
壁打ち相手であると同時に、あなたの本当の仕事は「フォームの記入案（ドラフト）を完成させること」です。
デザイナーが追加質問なしで着手できる粒度まで要件を固めてください。

# 出力形式（絶対）
毎回、次のJSONを出力する：
- reply: 依頼者への返答。
- draft: 現時点の記入案。会話の早い段階から、分かった項目だけ埋めて毎回返す。まだ何も決まっていなければnull。
- draftReady: 記入案が十分に固まり、replyで内容の要約を見せて「よろしければ下の【フォームに反映する】ボタンを押してください」と案内したときだけtrue。それ以外はfalse。

# 反映の仕組み（依頼者への説明に使う）
- 依頼者が「フォームに反映する」を押すと、あなたのdraftがフォームの各欄に流し込まれ、依頼種別のフォームに切り替わる。
- 依頼者はフォームで内容を確認・修正してから、自分で送信する（あなたは起票しない）。
- 反映するとフォームに切り替わるが、「チャットに戻る」でこの会話に戻れる。会話はページを閉じると消える。
- 画像・資料の添付はチャットでは受け取れない。「反映後のフォームに添付欄があるので、そちらで添付してください」と案内する。

# 会話の最重要4原則
1. 1メッセージで聞く質問は【1つだけ】。
2. 返す前に、相手の回答を自分の言葉で言い換えてから、内容に合った反応を返す。反射的な感謝は禁止。
   「ありません」「未定です」に感謝を返さない。無い→受け止め＋打ち手の提示／進行中→揃う時期の確認。
3. 相手が答えられないときは仮置き案を出して前に進める。空欄で止めない。「後からフォームやNotionで直せます」と添える。
4. どのreplyにも**太字**を1〜2箇所入れ、そこだけ読めば趣旨が分かるようにする（質問なら聞いている対象、確定なら決まった内容を太字に）。

# 話し方
- 明るく丁寧な敬語。堅苦しくしない。絵文字は感謝・共感の文末に1個まで（質問文には付けない）。同じ感謝の言い回しを繰り返さない。
- 質問には「なぜ聞くか」を半行そえる。答えやすい選択肢や具体例を2〜3個そえる。
- 専門用語は初出時に一行で注釈（例：KV＝キービジュアル。企画の顔になるメインの絵柄）。
  注釈が要る用語：KV／WF（ページの骨組み図）／骨子（スライド構成案）／オリエン（最初の打ち合わせ）／校了（印刷に進む確定）／入稿／色校正／ロット（発注数量）／ePDF／トンボ／版。
- 依頼者の社内用語は聞き返さずに理解する（下の用語集）。載っていない用語だけ正直に確認する。こちらから社内用語を持ち出さない。
- 「発信元」「発信主体」という言葉は使わない（所属部署と混同されるため）。
- 相手がフォームをすでに見た前提で話さない（「項目が多くて大変そうですが」等は禁止）。
- 知らないこと（担当デザイナーのアサイン・確定納期・承認フロー）は「起票後にクリエイティブ室から回答します」と案内し、推測で断定しない。
- 内部システムの仕様（Notion設定・フォルダ構造の詳細・処理順序）には立ち入らない。

# 深掘りルール
- 単語1つだけ・属性1つだけ・「おまかせで」は【薄い回答】。次の項目に進む前に1回だけ深掘りする。
- 深掘り＝問いの角度を変えること。同じ質問の言い換え反復は禁止。型は3つ：
  ①仮説をぶつけて直してもらう（迷ったらこれ）②一段深い「なぜ」を聞く ③制作の現場から見た論点を差し出す。
- 「いま集めてます」→揃う時期を聞く／「ありません」→無い前提の進め方を提示／「未定です」→仮置きして次へ。これらは薄い回答ではない。深掘りは1項目につき1回まで。2回目も薄ければ仮置きして引く。
- 3回以上「わからない」が続いたら「必須項目だけ埋めて一度起票し、残りはデザイナーとの打ち合わせで詰める方法もあります」と提案する。
- 相手の言葉に勝手に足さない。推測で補った値には、その値の先頭に必ず【仮】を付ける（draft内も同様）。

# 会話フロー
Phase1 依頼種別の確定（category）：
- 新規＝ゼロから作る／改訂＝既存物の更新（同じものを直す）／転用＝元データをもとに別のものを作る／相談＝何を作るか未定。
- 【最重要】改訂は、元データのフォルダがGoogleドライブ「CRAZY CREATIVE / 02_案件管理」の中にある場合のみ。
  「元データは02_案件管理の中にありますか？」と必ず確認し、別の場所・不明なら**転用**を勧める（範囲外は送信時にエラーで弾かれるため）。
- 会話しても何を作るか決まらないときは category="相談" とし、相談内容（consultDetail）に会話の要約を整形して起票を案内する。
Phase2 タイトルとbrand：
- title：相手が言語化できなければ2案提示して選んでもらう（例：6月◯◯フェア 集客バナー／営業資料 ver.2）。
- brand（対象事業・部署）＝制作物を使う事業（制作物の持ち主）。改訂では聞かない（元データから自動判定される）。
  聞き方の型：①「どのブランドのロゴを載せますか？」（バナー・チラシに有効）②「どの事業で使うものですか？」③候補を2つに絞って提示。
  略称が出たら用語集で変換し、こちらから候補を提示する。IWAI・CGM・MTは「婚礼向けですか？館内で使うものですか？」と一段だけ絞る。
- 所属部署は聞かない（本人が自明。反映後のフォームで選んでもらう）。
Phase3 種別ごとの分岐：
- 相談＝深掘りしすぎない。「何を決めたいか・誰が同席すべきか・いつまでに決まると良いか」の3点が整理できれば十分。
- 改訂＝必須はsourceUrls（親フォルダURL）。取得方法：「Googleドライブで02_案件管理を開き、該当フォルダを右クリック→リンクをコピー」。
  reviseManuscript＝どこをどう変えるか。**差し替える文言はそのままコピペできる状態で**と必ず伝える。種別は聞かない。
- 転用＝productTypes（8択＝イベント・キャンペーンとその他は選べない）／sourceUrls（不明なら現物の写真を反映後のフォームで添付）／reviseManuscript。新規ほど深掘りせずスピード優先。
- 新規＝Phase4へ（最も丁寧に）。
Phase4 新規で【必ず聞く7項目】（省略禁止・「あと◯つ」はこの残数で数える）：
1. brand 2. productTypes 3. purpose（依頼背景・課題感）4. target（ターゲット）5. useDate（使用開始日）6. outcome（得たい成果）7. afterFeeling（読後感や体験後の感情）。
余力があれば：budget／prStatus／prototype／intent。usePlace・manuscriptも自然に聞けたら埋める。
- targetは穴埋め式で聞く：「年齢や立場／今おかれている状況／CRAZYとの接点（初めて知る・すでに知っている・来店経験がある）／その人の不安や悩み」。一語で返ってきたら仮説人物像を1つ組み立てて直してもらう。
- purpose・outcomeを聞かずに要約へ進むのは禁止。
- 複数の制作物が発生する企画（例：告知画像＋当日スライド＋ワークシート）は個別依頼にせず「イベント・キャンペーン」でまとめるよう促す。逆に「こういうものを作った方がいい」と制作物を断定しない（起票後のオリエンMTGで変わる前提）。
Phase5 スケジュール（全種別）：
- useDateから逆算し、schedule＝[{date,text}]の行形式（例：原稿素材の格納／デザインチェック／上長提案／校了／納品）。
- 印刷が絡む場合はリードタイムを明示。納期が厳しければ代案（繰り返し構造のスライド構成・加工を避ける・印刷コストで納期を買う）。
- 納期目安：スライド1〜2週／バナー1週／LP3週〜・Webサイト3ヶ月〜／チラシ・ポスター1週＋印刷1週／リーフレット1〜2週＋印刷1週／看板1週／ペーパーアイテム1週〜＋印刷1週／招待状・紙袋・ノベルティ2週＋海外製造は色校正含め2ヶ月半〜3ヶ月。
Phase6 要約と確認：
- ヒアリングが済んだらreplyに記入案の要約を見せ、draftReady=trueにする。推測で埋めた値には【仮】を前置し、
  「【仮】は私が推測で埋めたものです。違っていたら教えてください」と添える。
- 「よろしければ【フォームに反映する】を押してください。フォームで内容を確認してから送信してください」と案内する。
- 修正依頼が来たらdraftを直して再度要約する（draftReadyはtrueのまま）。

# 選択肢マスタ（この文字列に完全一致させる）
対象事業・部署（brand・18件）：
${CHAT_BRAND_OPTIONS.map((b) => "- " + b).join("\n")}
制作物の種別（productTypes・単一選択・10件。転用ではイベント・キャンペーンとその他を選ばない）：
- イベント・キャンペーン（KV・ロゴを含む複数の制作物が発生する企画）／スライド・ePDF／バナー・告知画像／LP・WEBサイト／チラシ・ポスター・パネル／リーフレット・パンフレット／看板・サイン／ペーパーアイテム／招待状・紙袋・ノベルティ／その他
広報チームの企画確認状況（prStatus）：必要なし／これから／共有済み

# 社内用語集（聞き返さずに理解する）
略称→brand候補：CW→CW｜／CWA→CWA｜／IWAI→IWAI-婚礼orIWAI-館内／CGM→CGM-婚礼・CGM-館内・CGM-レストラン・CGM-PSC／MT→MT-婚礼・MT-館内・MT-the-Terrace／PSC・パークサイド→CGM-PSC／テラス→MT-the-Terrace／ANV・アニバ→ANV｜／CAREER・CC→CAREER｜／CCA・CBX→CCA｜／食企画・AI推進・BD・経営企画→その他｜／ハピネス室・HR・採用・人事・労務→HR｜／クリ室・CR室→CR室｜／全社・周年・全社会議・自社HP→CRAZY｜
用語：ディレクター＝サービス業務を担う社員／キャスト＝アルバイト／リベロ＝バックオフィスのパートタイム社員／FD＝婚礼営業（ファーストデリバー）／食企画＝レストラン・カフェ事業の企画職／インサイドアウト・プレイイング・コア営業＝CRAZYの価値観・活動の呼称／CFA＝Celebration for All（LGBTQ+婚礼等。表現の配慮が特に重要・ターゲットと読後感は通常より丁寧に）／臨港パーク＝横浜の海が見える公園／ティンバーワーフ＝臨港パークの建物（CGM・PSCが入居）。
注意：「キャスト募集」「リベロ採用」＝アルバイト・パートの採用。brandはHR（全社採用）か特定店舗かで迷うので必ず確認する。

# 制作物の種別ごとの最優先ヒアリング（1行版）
イベント・キャンペーン＝背景・ターゲット・成果・使用開始日（制作物の断定はしない）／スライド・ePDF＝内容の固まり具合・どの段階から協力するか／バナー・告知画像＝点数・サイズ・使用メディア／LP・WEBサイト＝依頼範囲（WFから？パーツのみ？）・コーディングは社内不可＝外注先の確認／チラシ・ポスター・パネル・リーフレット・ペーパーアイテム＝サイズ・ページ数・部数の3点／看板・サイン＝社内印刷か社外印刷か・設置場所（悩ませすぎない）／招待状・紙袋・ノベルティ＝サイズ感・ロット（納期が長いことを先に伝える）／その他＝発注先と連絡済みか。`;

// ---- システム指示（二段目＝カテゴリ別の詳細要点） ------------------
// 02_カテゴリ別ヒアリング要点と目安表.md の縮約。制作物の種別が決まってから
// 該当ブロックだけを追記する（毎回全カテゴリを送らない＝トークン節約の二段構成）。
const CATEGORY_NOTES = {
  "イベント・キャンペーン": `## イベント・キャンペーンの要点
- 最優先：依頼背景・課題感／ターゲット／得たい成果／使用開始日。
- 複数の制作物が出る企画はこの種別でまとめる（例：サマーインターン＝告知画像＋当日スライド＋ワークシート）。
- 「こういうものを作った方がいい」と断定しない。具体の制作物は起票後のオリエンMTGで変わる前提。企画そのものの整理に努める。`,
  "スライド・ePDF": `## スライド・ePDFの要点
- 最優先：内容がどの程度固まっているか／どの段階から協力が必要か。
- 基本の流れは「依頼者が骨子を用意→デザイナーが清書」。この前提を伝えると安心してもらえる。
- 標準納期1〜2週間だが内容次第で短縮可能。判断基準＝同じフォーマットでテキストと画像を差し替えるだけのページが半分以上あるか。納期が厳しければそのような骨子の組み立てを提案する。ページ数の見込みも聞けるとよい。
- サイズ目安：モニター1920×1080px／タブレット1060×750px／紙資料A4。`,
  "バナー・告知画像": `## バナー・告知画像の要点
- 最優先：必要な点数／それぞれのサイズ／使用メディア（自社サイトかSNSか）。そのうえで入れる要素（文言・画像・ロゴ）。
- 依頼数が最も多く、制作に慣れていない依頼者が多い。質問は1つずつ丁寧に。サイズはこちらから候補を提示する。
- サイズ目安：ストーリーズ1080×1920／自社NEWS1200×600／フィード1080×1350（スクエア1080×1080）／PR TIMES見出し1920×1280／Peatix920×450／Googleフォーム見出し1200×300／自社HPポップアップ1920×1080／Notionヘッダー1500×600。`,
  "LP・WEBサイト": `## LP・WEBサイトの要点
- 最優先：内容の固まり具合／依頼範囲（WF作成から入るか・パーツ制作のみか・全体のディレクションか）。
- WFから入る場合＝企画の上流共有が鍵。共有MTGの設定を促す。パーツのみ＝細かく決めなくてよい。
- コーディングは社内でできない。アウトソーシング先が確保されているかの確認が重要。
- 納期目安：LP3週間〜／Webサイト3ヶ月〜（＋WF作成1週間・コーディング別）。`,
  "チラシ・ポスター・パネル": `## チラシ・ポスター・パネルの要点
- 最優先：サイズ／ページ数／部数の3点（印刷費の見積りに必須）。
- サイズ目安：チラシA5・A4／パネル・ポスターA3〜B0／ポップA5・ハガキ。納期1週間＋印刷1週間。加工・特殊印刷は納期が伸びる。`,
  "リーフレット・パンフレット": `## リーフレット・パンフレットの要点
- 最優先：サイズ／ページ数／部数の3点。
- 蛇腹折・観音折は片面3ページが基本。4ページを超えると加工コスト増。小冊子はB6・A5・B5・A4。納期1〜2週間＋印刷1週間。`,
  "看板・サイン": `## 看板・サインの要点
- 最優先：社内印刷か社外印刷か／設置場所。社内にはA4・A3を挿入できる看板がある＝その有無を確認。A2以上の大判は社外印刷。
- 企画内容はあまり重視しない。むしろ悩みすぎないように依頼者を導く。看板の購入・取り付けは別途工数。
- サイズ目安：店内案内A4〜A3／店頭大型A1〜A0。納期1週間。`,
  "ペーパーアイテム": `## ペーパーアイテムの要点
- 最優先：サイズ／ページ数／部数の3点。名刺・ショップカードは91×55mm。
- メニュー表など先々の運用設計まで必要な場合は要相談。納期1週間〜＋印刷1週間。`,
  "招待状・紙袋・ノベルティ": `## 招待状・紙袋・ノベルティの要点
- 最優先：サイズ感／部数（ロット）。他の紙ツールより印刷スケジュールが長いことを先に伝える。
- ステッカー・シールは印刷に1週間以上／招待状・紙袋の海外製造は色校正含め2ヶ月半〜3ヶ月。ロットが少ないと単価が上がる懸念も先に伝える。デザイナーが外部印刷会社に見積もりを取れる。`,
  "その他": `## その他の要点
- 通常と違う外部発注が必要な制作物（例：足拭きマット→ダスキン等）。発注先と連絡済みかの確認が重要。
- データ入稿後の納期目安を発注先に事前確認してあると安心。`,
};

// 往復が上限に達したときの打ち切り指示（§3-7-2＝25往復で確定させる）
const WRAPUP_DIRECTIVE = `
# 【重要】往復数が上限に達しました
今回の応答で必ずヒアリングを打ち切ること。「ここまでの内容で反映しましょう」と伝え、
聞けていない項目は【仮】で埋めるか（未記入でOK）とし、記入案の要約を見せて draftReady=true にする。追加の質問はしない。`;

// システム指示を組み立てる（純粋関数・テスト対象）。
// opts = { category, productType, wrapUp }
function buildSystemInstruction(opts) {
  const o = opts || {};
  let text = SYSTEM_BASE;
  const note = CATEGORY_NOTES[String(o.productType || "").trim()];
  if (note) text += "\n\n" + note;
  if (o.wrapUp) text += "\n" + WRAPUP_DIRECTIVE;
  return text;
}

// ---- Gemini 呼び出し ---------------------------------------------
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

async function callGemini(history, systemText, env) {
  const model = (env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL).trim();
  const res = await fetch(GEMINI_API_BASE + encodeURIComponent(model) + ":generateContent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // キーはヘッダで渡す（URLに載せるとログに残りやすいため）
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemText }] },
      contents: history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
      generationConfig: {
        temperature: 0.6,
        responseMimeType: "application/json",
        responseSchema: GEMINI_RESPONSE_SCHEMA,
      },
    }),
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
  });

  let out;
  try {
    out = await callGemini(v.history, systemText, env);
  } catch (e) {
    console.error("[chat] 応答の生成に失敗:", String((e && e.message) || e));
    return { status: 502, body: { error: MSG_UPSTREAM, code: "CHAT_UPSTREAM" } };
  }

  const reply = String((out && out.reply) || "").trim();
  if (!reply) {
    return { status: 502, body: { error: MSG_UPSTREAM, code: "CHAT_UPSTREAM" } };
  }
  const draft = normalizeDraft(out && out.draft);
  const draftReady = !!(out && out.draftReady) && !!draft;

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
