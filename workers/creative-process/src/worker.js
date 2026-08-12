// ============================================================
// creative-process Worker（制作依頼ツール／フェーズ3: Notion一本化）
// ------------------------------------------------------------
// 役割：依頼フォーム（静的HTML）から送られた1件の依頼を、サーバー側で一括処理する。
//   ・Notion DB にページを作成（プロパティ＋本文全文＋参考画像）＝唯一の正本
//   ・Drive の 02_案件管理 配下に案件フォルダを自動作成（V1-5）
//   ※Slack自動投稿は白紙化により撤去済み（2026-08-11）。受付chへの共有は依頼者の手動投稿で行う。
//
// フェーズ3（Notion一本化・2026-07）：
//   - 共有URL（/v/<id>）の発行を廃止。依頼の正本は Notion ページただ1つ。
//   - フェーズ2の再編集機構（form:<id>復元・?edit・更新版追記）を撤去。
//     内容の修正は Notion ページ上で直接行う（履歴は Notion のページ履歴が担う）。
//   - 参考画像は Notion File Upload API でページ本文に埋め込む（共有HTML廃止の代替）。
//     アップロードに失敗した分は本文に「⚠️失敗N枚」と記録し、送信自体は成功させる。
//   - 移行措置：旧 /v/<id> は form:<id>（フェーズ2の残置データ・TTLで自然消滅）が
//     残っていれば notionUrl へ302リダイレクト。無ければ案内ページを表示する。
//
// フェーズ1（Googleログイン・継続）：
//   フォームは名前・メールを手入力せず、GISのIDトークン（JWT）を idToken として送る。
//   Worker は Google の公開鍵（JWKS）で署名を検証し、iss / aud / exp / hd=crazy.co.jp /
//   email_verified を確認したうえで、名前・メールをトークンから取り出して使う。
//   クライアントが送ってきた requesterName / requesterEmail は一切信用しない。
//
// エンドポイント：
//   POST /submit    … フォーム送信。{ ok, notionUrl, notionPageId, seqLabel, imagesQueued, deferred } を返す
//                      （V1-5.8＝画像・Driveの結果は応答に含まれない。応答後に処理される）
//   GET  /v/<id>    … 【移行措置】Notionページへ302リダイレクト（記録が無い旧依頼は案内ページ）
//   GET  /form/<id> … 【廃止】410 を返す（開きっぱなしの旧編集画面への案内用）
//   GET  /          … 稼働確認
//
// 環境変数（Secrets / Vars）：
//   NOTION_TOKEN      （必須）Notion インテグレーションのトークン
//   NOTION_DB_ID      （必須）登録先DBの database_id
//   GOOGLE_CLIENT_ID  （必須）GoogleのOAuthクライアントID。IDトークンの aud 検証に使用
//   GOOGLE_CLIENT_SECRET（必須）同クライアントのシークレット。認可コード→IDトークンの交換に使用
//                      ※Secretsにのみ置く。フォームHTMLやリポジトリには絶対に書かない
//   ALLOWED_ORIGIN    （任意）許可するフォームのオリジン。カンマ区切り可。未設定なら全許可
//   NOTION_VERSION    （任意）Notion APIバージョン。未設定なら "2022-06-28"
//   GOOGLE_SA_EMAIL   （任意・V1-5）Driveサービスアカウントのメールアドレス
//   GOOGLE_SA_PRIVATE_KEY（任意・V1-5）同アカウントの秘密鍵（PKCS#8 PEM）
//                      ※どちらか未設定ならDriveフォルダ作成はスキップされる（送信は成功する）
//
// V1-5（Drive自動フォルダ作成・2026-08）：
//   依頼1件ごとに 02_案件管理 配下へ案件フォルダを作り、URLをNotionの
//   「データ格納先」に書き戻す。番号は対象事業・部署ごとの連番（no00001形式）で、
//   発番元はNotionの「起票番号」プロパティの最大値。詳細は下の該当セクションを参照。
//
// V1-5.8（起票高速化・2026-08）：
//   /submit の応答は「Notionページ作成の直後」に返す。時間のかかる後続処理は
//   ctx.waitUntil で応答後（バックグラウンド）に回す＝依頼者の待ち時間を数秒短縮する。
//   - 応答後に回すもの：①参考画像のアップロード＋本文への追記（並列化済み）
//                       ②Driveフォルダ作成＋「データ格納先」の書き戻し
//   - 同期のまま残すもの：ログイン検証／冪等チェック／改訂の親フォルダ事前チェック（400で弾く）／
//                       起票番号の採番（ページのプロパティに入れるため）／Notionページ作成
//   - ページは「画像なし」で先に作り、画像はアップロード完了後に本文へ追記する。
//     副作用＝完了画面から即Notionを開くと参考画像が数秒〜十数秒遅れて現れる（許容済み・SPEC §注記）。
//   - 冪等キーの結果保存も応答前に行う（後続処理の結果は含まれない）。
//
// KVキー（binding=REQUESTS）：
//   idem:<key>     冪等キー（二重送信防止・7日保持）
//   guest:<email>  旧・既知依頼者リスト（Slack自動投稿の白紙化〈2026-08-11〉で不使用。残置データは無害）
//   form:<id> / html:<id>  フェーズ2以前の残置データ（新規保存はしない。TTLで自然消滅）
// ============================================================

// ---- 種別ごとの「長文与件」項目（フォームのname → 見出しラベル） ----
// Notion本文の見出し構成に使う。順序＝表示順。
const SEC_YOKEN = [
  ["purpose", "依頼背景・課題感"],
  ["target", "ターゲット"],
  ["useDate", "使用開始日"],
  ["usePlace", "使用場所・使用シーン"],
  ["outcome", "得たい成果"],
  ["afterFeeling", "読後感や体験後の感情"],
  ["budget", "予算感"],
];
// 「広報チームの企画確認状況」はフォーム上でスケジュールより前にあるため、ここでも先頭に置く。
const SEC_SEISAKU = [
  ["prStatus", "広報チームの企画確認状況"],
  ["manuscript", "制作物の概要"],
  ["prototype", "プロトタイプ"],
  ["intent", "プロジェクトに対する想い"],
];
const SEC_SOUDAN = [
  ["consultDetail", "相談内容"],
];
// 【V1-5.6】「改訂・流用」を「改訂」「転用」に分離（Figma第3次改修に追従）。
//   改訂＝同じものを直す（親フォルダURL必須・その中にフォルダを作る）
//   転用＝既存データをもとに別のものを作る（新規と同じ置き場・元URLは記録のみ）
const SEC_KAITEI = [
  ["sourceUrls", "改訂するデータの親フォルダのURL"],
  ["reviseManuscript", "制作内容"],
];
const SEC_TENYO = [
  ["sourceUrls", "転用元のデータ"],
  ["reviseManuscript", "制作内容"],
];
// 【互換】旧カテゴリ（2026-08-11以前のフォームが送る値）。デプロイの過渡期用に残す。
const SEC_KAITEI_LEGACY = [
  ["sourceUrls", "改訂・流用元のデータ"],
  ["reviseManuscript", "制作内容"],
];

// 依頼種別 → 表示する長文セクション
function sectionsFor(category) {
  if (category === "相談") return SEC_SOUDAN;
  if (category === "改訂") return SEC_KAITEI;
  if (category === "転用") return SEC_TENYO;
  if (category === "改訂・流用") return SEC_KAITEI_LEGACY;
  // 新規は与件整理＋制作内容
  return SEC_YOKEN.concat(SEC_SEISAKU);
}

const CORS_BASE = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  // Authorization は廃止済みの /form/<id>（410案内）へ旧画面が届くように残している
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ---- 小物ユーティリティ ----------------------------------------

function resolveCorsOrigin(request, env) {
  const allow = (env.ALLOWED_ORIGIN || "").trim();
  if (!allow) return "*";
  const origin = request.headers.get("Origin") || "";
  const list = allow.split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : list[0];
}

function corsHeaders(request, env) {
  return { ...CORS_BASE, "Access-Control-Allow-Origin": resolveCorsOrigin(request, env) };
}

function json(obj, status, request, env) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request, env) },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function isAllowedOrigin(request, env) {
  const allow = (env.ALLOWED_ORIGIN || "").trim();
  if (!allow) return true; // 未設定＝制限なし（開発初期）
  const origin = request.headers.get("Origin") || "";
  const list = allow.split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(origin);
}

// 添付画像（安全な画像data URLのみ許可・最大10枚）
// セキュリティ：MIMEとbase64本体まで厳密に検証し、スクリプト実行可能な svg+xml は許可しない。
// フォームは image/jpeg base64 のみ生成する。
const SAFE_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
function asImageList(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((s) => typeof s === "string" && SAFE_IMAGE_RE.test(s)).slice(0, 10);
}

// スケジュール感（マイルストーン）：[{date, text}] を整形。最大20件。
// ※Notionプロパティには入れず、ページ本文にのみ反映する。
function asScheduleList(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((m) => ({
      date: m && m.date ? String(m.date).trim() : "",
      text: m && m.text ? String(m.text).trim() : "",
    }))
    .filter((m) => m.date || m.text)
    .slice(0, 20);
}

// productTypes は配列でも文字列でも受ける
function asProductTypeList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) return v.split(",").map((x) => x.trim()).filter(Boolean);
  return [];
}

// ---- GoogleログインのIDトークン検証（フェーズ1） -----------------
// GIS が発行する IDトークン（RS256署名のJWT）を検証する。
//   1. Google の公開鍵一覧（JWKS）を取得（メモリに約1時間キャッシュ）
//   2. WebCrypto で署名を検証
//   3. iss / aud / exp / hd / email_verified をチェック
// 検証に通ったときだけ { name, email } を返す。失敗は AuthError を投げる。

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ALLOWED_HD = "crazy.co.jp";
let jwksCache = { keys: null, fetchedAt: 0 }; // Workerインスタンス単位のキャッシュ

class AuthError extends Error {}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function getGoogleJwks() {
  const ONE_HOUR = 60 * 60 * 1000;
  if (jwksCache.keys && Date.now() - jwksCache.fetchedAt < ONE_HOUR) return jwksCache.keys;
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new AuthError("Googleの公開鍵の取得に失敗しました");
  const body = await res.json();
  jwksCache = { keys: body.keys || [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

async function verifyGoogleIdToken(idToken, env) {
  if (typeof idToken !== "string" || idToken.split(".").length !== 3) {
    throw new AuthError("ログイン情報がありません。Googleでログインしてから送信してください");
  }
  const clientId = (env.GOOGLE_CLIENT_ID || "").trim();
  if (!clientId) throw new Error("サーバー設定が未完了です（GOOGLE_CLIENT_ID）");

  const [headB64, payloadB64, sigB64] = idToken.split(".");
  let header, payload;
  try {
    header = b64urlToJson(headB64);
    payload = b64urlToJson(payloadB64);
  } catch {
    throw new AuthError("ログイン情報の形式が不正です");
  }
  if (header.alg !== "RS256") throw new AuthError("ログイン情報の形式が不正です（alg）");

  // 署名検証（kidが見つからない場合は鍵ローテーション直後の可能性→キャッシュを捨てて1回だけ再取得）
  let keys = await getGoogleJwks();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    jwksCache = { keys: null, fetchedAt: 0 };
    keys = await getGoogleJwks();
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new AuthError("ログインの検証に失敗しました。もう一度ログインしてください");

  const key = await crypto.subtle.importKey(
    "jwk", jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key,
    b64urlToBytes(sigB64),
    new TextEncoder().encode(headB64 + "." + payloadB64)
  );
  if (!valid) throw new AuthError("ログインの検証に失敗しました。もう一度ログインしてください");

  // クレーム検証
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
    throw new AuthError("ログインの検証に失敗しました（発行元）");
  }
  if (payload.aud !== clientId) throw new AuthError("ログインの検証に失敗しました（対象クライアント）");
  if (typeof payload.exp !== "number" || payload.exp < now - 60) {
    throw new AuthError("ログインの有効期限が切れました。もう一度ログインしてください");
  }
  const email = String(payload.email || "");
  if (payload.email_verified !== true) throw new AuthError("メールアドレスが未確認のアカウントです");
  if (payload.hd !== ALLOWED_HD || !/@crazy\.co\.jp$/i.test(email)) {
    throw new AuthError("@crazy.co.jp のアカウントでログインしてください");
  }
  return { name: String(payload.name || "") || email, email, exp: payload.exp };
}

// ---- Googleログイン：認可コード → IDトークン --------------------
// フォームは自前のボタンから認可コードを受け取り、それをここへ送る。
// クライアントシークレットはWorker Secrets（GOOGLE_CLIENT_SECRET）にのみ置き、
// ブラウザには一切渡さない。
// ポップアップ方式のトークン交換では redirect_uri に「呼び出し元ページのオリジン」を使う
// （Google公式仕様: https://developers.google.com/identity/oauth2/web/guides/use-code-model ）。
// 旧実装の "postmessage"（gapi時代の慣習）はGoogleが交換を拒否するようになったため廃止（2026-08-12）。
async function exchangeCodeForIdToken(code, env, origin) {
  const clientId = (env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    throw new Error("サーバー設定が未完了です（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）");
  }
  // origin は isAllowedOrigin 検証済みリクエストの Origin ヘッダ。
  // 万一空のとき（同一生成元ポリシー外のツール等）は ALLOWED_ORIGIN の先頭を使う。
  const redirectUri =
    (origin || "").trim() ||
    (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean)[0] || "";
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.id_token) {
    // Googleのエラー内容はブラウザにそのまま返さない（設定情報が漏れるため）。
    // 原因調査用にエラーコードだけサーバーログへ出す（`npx wrangler tail` で閲覧可）。
    console.error("[auth/exchange] Googleトークン交換に失敗:", res.status, out.error || "(エラーコードなし)");
    throw new AuthError("ログインに失敗しました。もう一度お試しください");
  }
  return out.id_token;
}

// ---- 移行措置（フェーズ3）：旧 /v/<id> の行き先 ------------------
// フェーズ2までに保存された form:<id>（フォームJSON）が残っていれば notionUrl を取り出す。
// 新規保存はしない（読み出し専用・TTL満了で自然消滅）。
async function loadFormRecord(env, id) {
  const raw = await env.REQUESTS.get("form:" + id);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// レコードからリダイレクト先（NotionページURL）を安全に取り出す。無ければ空文字。
function redirectTargetFor(record) {
  const u = record && typeof record.notionUrl === "string" ? record.notionUrl.trim() : "";
  return /^https:\/\//i.test(u) ? u : "";
}

// 旧共有URLへの案内ページ（記録が無い／期限切れの依頼向け・静的）
function buildGuideHtml() {
  return (
    '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>共有ページはNotionに移行しました</title><style>" +
    "body{font-family:-apple-system,'Hiragino Kaku Gothic ProN',sans-serif;background:#f5f6f8;color:#1f2430;margin:0;padding:24px;line-height:1.8}" +
    ".wrap{max-width:620px;margin:40px auto;background:#fff;border-radius:14px;box-shadow:0 6px 30px rgba(0,0,0,.06);padding:32px}" +
    "h1{font-size:19px;margin:0 0 12px}p{font-size:14px;margin:0 0 12px;color:#3a4150}" +
    ".note{font-size:12.5px;color:#8a92a0;border-top:1px solid #eceef1;padding-top:14px;margin-top:18px}" +
    "</style></head><body><div class=\"wrap\">" +
    "<h1>🗂 共有ページはNotionに移行しました</h1>" +
    "<p>制作依頼の内容は、現在は Notion の「クリエイティブプロジェクト」データベースにのみ保存されています。このURLでの共有ページは公開を終了しました。</p>" +
    "<p class=\"note\">依頼の内容の確認は、クリエイティブ室（宮川）までお問い合わせください。</p>" +
    "</div></body></html>"
  );
}

// ---- Notion 登録 ------------------------------------------------
// 最小プロパティ＋ページ本文（長文与件・スケジュール感・参考画像）。
// ※プロパティ名は DB「クリエイティブプロジェクト」の確定名に合わせている。名称変更時はここを直す。
// DBに存在しないプロパティ名を送るとNotion APIが400を返し、リクエスト全体が失敗する。
// ここに書いてよいのは「クリエイティブプロジェクト」に実在するプロパティだけ。
// ・「担当者」（person型）はクリエイティブ室側の割り当て欄なので、Workerからは書かない。
// ・依頼者のメールアドレスはプロパティに入れず、ページ本文の先頭に記載する。
function buildNotionProperties(data) {
  const props = {
    "案件名": { title: [{ text: { content: (data.title || "（無題）").slice(0, 2000) } }] },
    "依頼種別": { select: { name: data.category || "相談" } },
  };

  const productTypes = asProductTypeList(data.productTypes);

  if (data.brand) props["対象事業・部署"] = { select: { name: data.brand } };
  if (productTypes.length) props["制作物の種別"] = { multi_select: productTypes.map((n) => ({ name: n })) };
  if (data.requesterDept) props["所属部署"] = { select: { name: data.requesterDept } };
  if (data.requesterName) props["依頼者"] = { rich_text: [{ text: { content: data.requesterName } }] };
  if (data.dataStorage) props["データ格納先"] = { url: data.dataStorage };
  // 【V1-5】起票番号（対象事業・部署ごとの連番。例 "no00001"）。
  //   Driveのフォルダ名と完全に同じ文字列を入れる＝目視で1対1に照合できる。
  if (data.seqLabel) props["起票番号"] = { rich_text: [{ text: { content: data.seqLabel } }] };

  return props;
}

// 長文与件のセクション本文ブロック（見出し＋本文＋スケジュール感）を組み立てる。
function buildNotionSectionBlocks(data) {
  const blocks = [];

  // 依頼者情報（本文の先頭）。メールアドレスはプロパティに入れずここに残す。
  if (data.requesterName || data.requesterEmail) {
    const who = data.requesterEmail
      ? (data.requesterName || "") + "（" + data.requesterEmail + "）"
      : String(data.requesterName || "");
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: "依頼者：" + who } }] },
    });
  }

  const sections = sectionsFor(data.category);
  for (const [name, label] of sections) {
    const raw = data[name];
    const v = Array.isArray(raw)
      ? raw.map((x) => String(x).trim()).filter(Boolean).join("\n")
      : (raw || "").toString().trim();
    if (!v) continue;
    blocks.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: label } }] },
    });
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: v.slice(0, 2000) } }] },
    });
  }
  // スケジュール：本文へ箇条書きで（プロパティには入れない）。新規・改訂・流用の両方で使う。
  const schedule = asScheduleList(data.schedule);
  if (schedule.length) {
    blocks.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: "スケジュール" } }] },
    });
    for (const m of schedule) {
      const line = (m.date ? m.date + "　" : "") + m.text;
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ type: "text", text: { content: line.slice(0, 2000) } }] },
      });
    }
  }
  return blocks;
}

// 参考画像のブロック列（見出し → 画像 → 失敗注記）。
// 【V1-5.8】ページ作成時とバックグラウンドでの本文追記の両方で使うため、独立した関数に切り出した。
// imageUploads = { ids: [file_upload_id...], failed: 失敗枚数 }（uploadImagesToNotion の結果）
function buildImageBlocks(imageUploads) {
  const up = imageUploads || { ids: [], failed: 0 };
  const blocks = [];
  if (up.ids.length || up.failed) {
    blocks.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: "参考画像" } }] },
    });
    for (const id of up.ids) {
      blocks.push({
        object: "block",
        type: "image",
        image: { type: "file_upload", file_upload: { id } },
      });
    }
    if (up.failed) {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: "⚠️ 参考画像のアップロードに失敗：" + up.failed + "枚（お手数ですが元データを直接共有してください）" } }] },
      });
    }
  }
  return blocks;
}

// ページ本文全体（セクション本文 → 参考画像）。
function buildNotionBlocks(data, imageUploads) {
  return buildNotionSectionBlocks(data).concat(buildImageBlocks(imageUploads));
}

// ---- 参考画像のNotionアップロード（フェーズ3・File Upload API） --
// data:image/... base64 を Notion にアップロードし、file_upload の id を返す。
// 手順：① POST /v1/file_uploads で枠を作成 → ② /send に multipart で本体送信。
// 失敗しても依頼送信は止めない（buildNotionBlocks が「失敗N枚」を本文に記録する）。

const IMAGE_DATA_RE = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp" };

async function uploadOneImageToNotion(dataUrl, index, env) {
  const m = IMAGE_DATA_RE.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] === "image/jpg" ? "image/jpeg" : m[1];
  const filename = "参考画像-" + (index + 1) + "." + (IMAGE_EXT[mime] || "bin");
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const version = (env.NOTION_VERSION || "2022-06-28").trim();
  const authHeaders = {
    Authorization: "Bearer " + env.NOTION_TOKEN,
    "Notion-Version": version,
  };

  // ① アップロード枠の作成
  const createRes = await fetch("https://api.notion.com/v1/file_uploads", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ filename, content_type: mime }),
  });
  const created = await createRes.json().catch(() => ({}));
  if (!createRes.ok || !created.id) return null;

  // ② 本体の送信（multipart/form-data。Content-Typeはfetchが境界付きで自動設定）
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: mime }), filename);
  const sendRes = await fetch("https://api.notion.com/v1/file_uploads/" + created.id + "/send", {
    method: "POST",
    headers: authHeaders,
    body: fd,
  });
  if (!sendRes.ok) return null;
  return created.id;
}

async function uploadImagesToNotion(images, env) {
  // 【V1-5.8】直列→並列化。Promise.all は入力順どおりに結果を返すため、
  // 本文に載る画像の順序（依頼者が添付した順）は保たれる。
  // 失敗した1枚は null に落とし、全体は止めない（失敗枚数は本文の注記に使う）。
  const results = await Promise.all(
    images.map((img, i) => uploadOneImageToNotion(img, i, env).catch(() => null)),
  );
  const ids = results.filter(Boolean);
  return { ids, failed: results.length - ids.length };
}

async function createNotionPage(data, imageUploads, env) {
  const version = (env.NOTION_VERSION || "2022-06-28").trim();
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.NOTION_TOKEN,
      "Notion-Version": version,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: env.NOTION_DB_ID },
      properties: buildNotionProperties(data),
      children: buildNotionBlocks(data, imageUploads),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error("Notion登録に失敗: " + (body && body.message ? body.message : res.status));
  }
  const pageUrl = body.url || ("https://www.notion.so/" + String(body.id || "").replace(/-/g, ""));
  return { pageId: body.id, notionUrl: pageUrl };
}

// ============================================================
// Google Drive 自動フォルダ作成（V1-5）
// ------------------------------------------------------------
// 依頼1件につき、共有ドライブ「CRAZY CREATIVE」の 02_案件管理 配下に
// 案件フォルダ（＋3点セットのサブフォルダ）を作り、そのURLを
// Notion の「データ格納先」プロパティに書き戻す。
//
// 置き場所のルール（V1-5.6で改訂）：
//   新規・転用 … 02_案件管理/<対象事業・部署>/<種別フォルダ>/no00001_タイトル
//                 ※種別フォルダ＝「01_イベント・キャンペーン」〜「10_その他（基本的に使用しない）」。
//                   制作物の種別（単一選択）で振り分ける。棚が見つからなければ作る。
//                 ※転用の「転用元のデータ」URLは記録のみ。置き場所には使わない（元と並列に置く）。
//   改訂       … 「改訂するデータの親フォルダのURL」（必須）が指すフォルダの中に作る。
//                 【V1-5.7】親は 02_案件管理 の事業フォルダ（または相談）配下に限る。
//                 外を指している・アクセスできない場合は /submit の事前チェックが400で弾き、
//                 Notionページ自体を作らない（＝依頼種別「転用」への切り替えを促す）。
//                 貼られたのが番号付き案件フォルダの中の番号付きフォルダなら1段引き上げる
//                 （＝入れ子は2階層で止める）。
//   相談       … 02_案件管理/相談/[対象事業・部署の略称]_no00005_タイトル（フラット）
//
// 起票番号（no00001）のルール：
//   - 対象事業・部署ごとの独立した連番。IWAIの00001とCGMの00001は別物。
//   - 発番元は Notion。DBを「対象事業・部署＝そのブランド」で絞り、
//     「起票番号」の最大値を取って +1 する（＝Notionが唯一の正本という方針に合わせる）。
//   - 常に5桁ゼロ埋め。文字列のまま比較しても数値順になる。
//   - Notionページを消すと欠番になる（最大値方式のため）。運用上の実害はない。
//   - 改訂はフォームに「対象事業・部署」が無い。親フォルダから事業フォルダをさかのぼって特定し、
//     採番のうえ Notion の「起票番号」「対象事業・部署」にも書き戻す。
//     相談フォルダ配下の案件はフォルダ名の [略称]_ から事業を引く。
//     【V1-5.7】特定できない親（02_案件管理の外）は事前チェックで送信ごと弾くため、ここには来ない。
//
// 失敗したときの方針：
//   Drive処理は「任意・失敗しても致命にしない」。フォルダが作れなくても
//   Notionページの作成（＝依頼そのもの）は成立させ、依頼者の再送信を求めない。
// ============================================================

// 対象事業・部署（Notionのselect値）→ 02_案件管理 配下のフォルダID
// ※名前の一致で探すのではなくIDで直接指定する。フォルダ名を変えても壊れないため。
const DRIVE_BRAND_FOLDERS = {
  "ANV｜アニバに関する制作物": "1WvB1FUv9p-RVUlXl27Y95hz2hs2X3Uua",
  "CAREER｜CRAZY CAREERに関する制作物": "15EC0rbFYHV-c2bL6DZUCHdH52AvaH_VW",
  "CCA｜CCA事業に関する制作物": "1uMBVH4jORUhDoofMQcGXHjRHF_DHRPG1",
  "CGM-PSC｜PARKSIDE CAFEに関する制作物": "1wdy1HXUNnASJseQAR5nipvQvZwiUwfLL",
  "CGM-レストラン｜レストランに関する制作物": "1daaRMbf_7Z0f6cS0_ir3CkmIHXLqhX7A",
  "CGM-館内｜館内備品等に関する制作物": "1M1k_bStUW4yBOyFZ7Va_2A0JimEx29r1",
  "CGM-婚礼｜婚礼に関する制作物": "1nMI3usJ925tTK__iilWIGwYaet7N7kGV",
  "CRAZY｜全社周年・全社会議・自社HP等に関する制作物": "1c3dMues92Eu3Yv5VcklJxdzhQtNSnSK5",
  // 【互換】2026-08-06のNotion選択肢リネーム前の名前。リネーム漏れでもフォルダ作成が
  //   止まらないように残す。全レコードの移行が確認できたら削除してよい。
  "CRAZY｜全社周年・自社WEBサイト等に関する制作物": "1c3dMues92Eu3Yv5VcklJxdzhQtNSnSK5",
  "CR室｜クリ室の自主企画・外部案件の管理用": "114OFh9NLBMTejui-L79_1gDk7sskOhfN",
  "CW｜CWブランド全体の婚礼・営業に関する制作物": "1vyGDL23XV5Pu1dvfiYXUSr9ryBFdYEWn",
  "CWA｜CWAに関する制作物": "1bOftDrEvABYRW0KxAdw4-QWnJy5meZ1S",
  "HR｜ハピネス室（採用・人事・労務）・組織開発に関する制作物": "1cVDtUY_dV16cB2ZWvB4mCPs7z9TDTPTi",
  "IWAI-婚礼｜婚礼に関する制作物": "1-qUTHhUDMojziFirGsowOmu4c4DHsdzt",
  "IWAI-館内｜館内備品等に関する制作物": "1qv9_Tt5BxwfVOYjs9jViDiGLrWatd3ve",
  "MT-the-Terrace｜the Terraceに関する制作物": "1A4XwDKHz6A_cR3Eyq0_H1MIPrt-jnyL8",
  "MT-婚礼｜婚礼に関する制作物": "1f-LlAwDmQwlf9gX3hSJRicoy6zYcN_sm",
  "MT-館内｜館内備品等に関する制作物": "1y63-N3ihy2OqOnZS7P1R4HzE_sH8v0ii",
  "その他｜AI推進・BD・食企画・経営企画等に関する制作物": "1qA1BqUdsxqwSqddQf66fLFTf4taWzj16",
};

// 「02_案件管理」のルート。改訂の親フォルダはこの配下に限る（V1-5.7）。診断でも使う。
const DRIVE_KANRI_FOLDER_ID = "1T3J-bOCpWrCKDlOwb3-wFIImg6mgNuFz";

// 「相談」の置き場。02_案件管理 直下（2026-08-06作成）。
const DRIVE_SOUDAN_FOLDER_ID = "1_YbqkpMimOFM5_zMF91YqQqw2jH38zvu";

// フォルダID → 対象事業・部署 の逆引き（改訂の事業推定に使う）。
// 互換キー（旧CRAZY名）は同じIDなので、先に定義された正式名が勝つ。
const DRIVE_FOLDER_TO_BRAND = {};
for (const [brand, id] of Object.entries(DRIVE_BRAND_FOLDERS)) {
  if (!DRIVE_FOLDER_TO_BRAND[id]) DRIVE_FOLDER_TO_BRAND[id] = brand;
}

// 【V1-5.6】制作物の種別 → 事業フォルダ直下の種別フォルダ（棚）の正式名。
// 実際の解決は名前検索で行う（brandFolderId配下から「数字_種別名…」に一致する子を探す）ため、
// Drive側で番号や補足が変わっても種別名が先頭に残っていれば追従できる。見つからなければこの名前で作る。
const DRIVE_TYPE_SHELVES = {
  "イベント・キャンペーン": "01_イベント・キャンペーン",
  "スライド・ePDF": "02_スライド・ePDF",
  "バナー・告知画像": "03_バナー・告知画像",
  "LP・WEBサイト": "04_LP・WEBサイト",
  "チラシ・ポスター・パネル": "05_チラシ・ポスター・パネル",
  "リーフレット・パンフレット": "06_リーフレット・パンフレット",
  "看板・サイン": "07_看板・サイン",
  "ペーパーアイテム": "08_ペーパーアイテム",
  "招待状・紙袋・ノベルティ": "09_招待状・紙袋・ノベルティ",
  "その他": "10_その他（基本的に使用しない）",
};

// 番号付き案件フォルダの名前パターン（no00001_… / [IWAI-婚礼]_no00005_…）
const NUMBERED_FOLDER_RE = /^(\[[^\]]*\]_)?no\d{5,}_/;

// 案件フォルダの中に必ず作るサブフォルダ（順序＝作成順＝名前順）
const DRIVE_SUBFOLDERS = ["01_支給素材", "02_作業データ", "03_納品データ"];

const DRIVE_SEQ_PROP = "起票番号";
const DRIVE_STORAGE_PROP = "データ格納先";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// 対象事業・部署の「｜」より前が略称（ANV / IWAI-婚礼 / MT-the-Terrace …）。
// 18件すべてこの形式なので、対応表を持たずに切り出せる。
function brandShortName(brand) {
  const s = String(brand || "").trim();
  if (!s) return "";
  const i = s.indexOf("｜");
  return (i > 0 ? s.slice(0, i) : s).trim();
}

// 5桁ゼロ埋め＋接頭辞 no（例: 1 → "no00001"）。
// 5桁を超えたら桁を伸ばす（並び順は崩れるが、番号が壊れるよりはよい）。
function formatSeq(n) {
  const num = Math.max(1, Math.floor(Number(n) || 1));
  return "no" + String(num).padStart(5, "0");
}

// "no00042" → 42。読めない文字列は 0（＝最大値の計算で無視される）。
function parseSeq(v) {
  const m = /^no(\d+)$/.exec(String(v || "").trim());
  return m ? parseInt(m[1], 10) : 0;
}

// Driveのフォルダ名に使えない・使うと事故る文字を落とす。
// スラッシュ系はパス区切りと誤解されるため全角ハイフンではなく半角ハイフンに寄せる。
function sanitizeFolderName(title) {
  const s = String(title || "")
    .replace(/[\\/]/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = s.slice(0, 60).trim();
  return cut || "無題";
}

// Drive のフォルダURL・ファイルURLから ID を取り出す。
// 対応: /drive/folders/<id> / /drive/u/0/folders/<id> / /open?id=<id> / /file/d/<id>/...
function extractDriveFolderId(urlText) {
  // 「改訂・流用元のデータ」は配列で届くことがある（フォームが行を増やせるため）。
  // 先に書かれたものを優先したいので、順に見て最初に解けたIDを採る。
  if (Array.isArray(urlText)) {
    for (const one of urlText) {
      const id = extractDriveFolderId(one);
      if (id) return id;
    }
    return "";
  }
  const s = String(urlText || "").trim();
  if (!s) return "";
  const patterns = [
    /drive\.google\.com\/[^\s]*?\/folders\/([A-Za-z0-9_-]{10,})/,
    /drive\.google\.com\/[^\s]*?[?&]id=([A-Za-z0-9_-]{10,})/,
    /drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,})/,
    /docs\.google\.com\/[^\s]*?[?&]id=([A-Za-z0-9_-]{10,})/,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) return m[1];
  }
  return "";
}

// サービスアカウントの秘密鍵（PKCS#8 PEM）を Web Crypto の CryptoKey にする。
// Secretには改行を含められるが、環境によっては "\n" のリテラルで入るため両対応する。
async function importServiceAccountKey(pem) {
  const body = String(pem || "")
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error("GOOGLE_SA_PRIVATE_KEY が空です");
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function b64urlFromBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlFromString(str) {
  return b64urlFromBytes(new TextEncoder().encode(str));
}

// サービスアカウントの自己署名JWT → Drive APIのアクセストークン（有効1時間）。
// メモリキャッシュはWorkerのインスタンス単位。使い回せるときだけ使う。
let driveTokenCache = { token: "", exp: 0 };
async function getDriveAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (driveTokenCache.token && driveTokenCache.exp - 60 > now) return driveTokenCache.token;

  const email = (env.GOOGLE_SA_EMAIL || "").trim();
  const pem = env.GOOGLE_SA_PRIVATE_KEY || "";
  if (!email || !pem) throw new Error("Drive未設定（GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY）");

  const header = b64urlFromString(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64urlFromString(JSON.stringify({
    iss: email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: GOOGLE_TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  }));
  const key = await importServiceAccountKey(pem);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(header + "." + claim),
  );
  const assertion = header + "." + claim + "." + b64urlFromBytes(new Uint8Array(sig));

  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error("Driveの認証に失敗: " + (body.error_description || body.error || res.status));
  }
  driveTokenCache = { token: body.access_token, exp: now + (body.expires_in || 3600) };
  return body.access_token;
}

async function driveFetch(path, init, token) {
  const res = await fetch(path, {
    ...init,
    headers: { Authorization: "Bearer " + token, ...(init && init.headers) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body && body.error && body.error.message ? body.error.message : res.status;
    throw new Error("Drive APIエラー: " + msg);
  }
  return body;
}

async function createDriveFolder(name, parentId, token) {
  return driveFetch(
    DRIVE_API + "?supportsAllDrives=true&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      }),
    },
    token,
  );
}

async function getDriveFile(fileId, token) {
  return driveFetch(
    DRIVE_API + "/" + encodeURIComponent(fileId) + "?supportsAllDrives=true&fields=id,name,mimeType,parents",
    { method: "GET" },
    token,
  );
}

// 事業フォルダ直下の子フォルダ一覧（棚の名前解決に使う）
async function listDriveChildFolders(parentId, token) {
  const q = "'" + parentId + "' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false";
  const body = await driveFetch(
    DRIVE_API + "?q=" + encodeURIComponent(q) +
      "&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name)&pageSize=100",
    { method: "GET" },
    token,
  );
  return body.files || [];
}

// 【V1-5.6】種別フォルダ（棚）を名前で解決する。無ければ正式名で作る。
// 一致判定＝「先頭の数字_を外した残りが種別名で始まる」。
//   例: 「10_その他（基本的に使用しない）」→「その他（…」→「その他」で始まる → 一致。
// 種別が未知（対応表に無い）の場合は null（呼び出し側が事業フォルダ直下に置く）。
async function resolveTypeShelf(brandFolderId, typeName, token) {
  const canonical = DRIVE_TYPE_SHELVES[String(typeName || "").trim()];
  if (!canonical) return null;
  try {
    const children = await listDriveChildFolders(brandFolderId, token);
    const hit = children.find((f) => String(f.name || "").replace(/^\d+_/, "").startsWith(String(typeName).trim()));
    if (hit) return hit.id;
  } catch {
    // 一覧に失敗しても作成は試みる
  }
  const made = await createDriveFolder(canonical, brandFolderId, token);
  return made.id;
}

// 【V1-5.6】改訂の親を決める（位置非依存）。
// 貼られたURLのフォルダをそのまま親にする。ファイルURLならその入れ物から始める。
// 「番号付き案件フォルダの中の番号付きフォルダ」を指していたら1段引き上げる（入れ子は2階層で止める）。
// たどれない場合は null（呼び出し側はフォルダを作らず、Notion本文に注記を残す）。
async function resolveKaiteiParent(sourceUrl, token) {
  const startId = extractDriveFolderId(sourceUrl);
  if (!startId) return null;

  let node;
  try {
    node = await getDriveFile(startId, token);
  } catch {
    return null;
  }
  if (node.mimeType !== "application/vnd.google-apps.folder") {
    const up = (node.parents || [])[0];
    if (!up) return null;
    try {
      node = await getDriveFile(up, token);
    } catch {
      return null;
    }
  }

  // 番号付き in 番号付き なら、案件フォルダの根元まで引き上げる（最大3段の保険）
  for (let i = 0; i < 3; i++) {
    if (!NUMBERED_FOLDER_RE.test(String(node.name || ""))) break;
    const up = (node.parents || [])[0];
    if (!up) break;
    let parent;
    try {
      parent = await getDriveFile(up, token);
    } catch {
      break;
    }
    if (!NUMBERED_FOLDER_RE.test(String(parent.name || ""))) break;
    node = parent;
  }
  return node; // { id, name, parents }
}

// 略称（[IWAI-婚礼] の中身）→ 対象事業・部署の正式名。相談フォルダ配下の案件の事業推定に使う。
function brandFromShortName(short) {
  const s = String(short || "").trim();
  if (!s) return "";
  for (const brand of Object.keys(DRIVE_BRAND_FOLDERS)) {
    if (brandShortName(brand) === s) return brand;
  }
  return "";
}

// 【V1-5.6】フォルダから親をさかのぼって「対象事業・部署」を推定する（改訂の採番用）。
// 事業フォルダ配下なら、そのフォルダIDから逆引きする。
// 相談フォルダ配下なら、起点フォルダ名の [略称]_ から逆引きする（相談発の案件の改訂）。
// 02_案件管理の外を指している場合は空文字（V1-5.7＝呼び出し側が送信自体を400で弾く）。
async function inferBrandFromFolder(node, token) {
  let cur = node;
  for (let i = 0; i < 6; i++) {
    if (!cur) return "";
    if (DRIVE_FOLDER_TO_BRAND[cur.id]) return DRIVE_FOLDER_TO_BRAND[cur.id];
    if (cur.id === DRIVE_SOUDAN_FOLDER_ID) {
      const m = /^\[([^\]]+)\]_/.exec(String(node.name || ""));
      return brandFromShortName(m ? m[1] : "");
    }
    const up = (cur.parents || [])[0];
    if (!up) return "";
    if (DRIVE_FOLDER_TO_BRAND[up]) return DRIVE_FOLDER_TO_BRAND[up];
    if (up === DRIVE_SOUDAN_FOLDER_ID) {
      const m = /^\[([^\]]+)\]_/.exec(String(node.name || ""));
      return brandFromShortName(m ? m[1] : "");
    }
    try {
      cur = await getDriveFile(up, token);
    } catch {
      return "";
    }
  }
  return "";
}

// Notion から「対象事業・部署＝brand」の最大 起票番号 を取り、+1 した番号を返す。
// 取得に失敗した場合も 1 を返して処理を止めない（重複は運用で直す方が安全）。
async function nextSeqNumber(env, brand) {
  const version = (env.NOTION_VERSION || "2022-06-28").trim();
  const res = await fetch("https://api.notion.com/v1/databases/" + env.NOTION_DB_ID + "/query", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.NOTION_TOKEN,
      "Notion-Version": version,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filter: { property: "対象事業・部署", select: { equals: brand } },
      sorts: [{ property: DRIVE_SEQ_PROP, direction: "descending" }],
      page_size: 1,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("起票番号の取得に失敗: " + (body.message || res.status));
  const row = (body.results || [])[0];
  const prop = row && row.properties ? row.properties[DRIVE_SEQ_PROP] : null;
  const text = prop && Array.isArray(prop.rich_text) && prop.rich_text[0]
    ? prop.rich_text[0].plain_text
    : "";
  return parseSeq(text) + 1;
}

// 案件フォルダ＋3点セットを作る。戻り値はフォルダのURL。
async function createProjectFolderTree(name, parentId, token) {
  const folder = await createDriveFolder(name, parentId, token);
  for (const sub of DRIVE_SUBFOLDERS) {
    // サブフォルダの失敗は致命にしない（親フォルダは使えるため）
    try { await createDriveFolder(sub, folder.id, token); } catch {}
  }
  return folder.webViewLink || ("https://drive.google.com/drive/folders/" + folder.id);
}

// 1件ぶんのフォルダ作成。呼び出し側は try/catch 不要（必ず結果オブジェクトを返す）。
// 戻り値: { created, url, reason, seqLabel, inferredBrand }
//   - seqLabel      … 実際にフォルダ名へ使った起票番号（改訂はここで採番するため呼び出し側に返す）
//   - inferredBrand … 改訂で親フォルダから推定できた対象事業・部署（Notionへ書き戻す用）
async function createDriveFolderForRequest(data, seqLabel, env) {
  const out = { created: false, url: "", reason: "", seqLabel: seqLabel || "", inferredBrand: "" };
  if (!(env.GOOGLE_SA_EMAIL || "").trim() || !env.GOOGLE_SA_PRIVATE_KEY) {
    out.reason = "Drive未設定（GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY）";
    return out;
  }

  const brand = String(data.brand || "").trim();
  const category = String(data.category || "").trim();

  try {
    const token = await getDriveAccessToken(env);
    const safeTitle = sanitizeFolderName(data.title);

    // 改訂：貼られた親フォルダの中に作る。
    // 【V1-5.7】親の解決と事業の推定は /submit の事前チェックで済んでいる
    // （02_案件管理の外は送信自体を400で弾く）。ここでは結果を受け取って作るだけ。
    if (category === "改訂") {
      let parentId = String(data._kaiteiParentId || "").trim();
      out.inferredBrand = String(data._kaiteiBrand || "").trim();
      if (!parentId) {
        // 事前チェックを通らない経路（想定外）への保険。ここで解決を試みる。
        const parent = await resolveKaiteiParent(data.sourceUrls, token);
        if (!parent) {
          out.reason = "改訂元の親フォルダにアクセスできませんでした（URLの誤り・権限不足の可能性）";
          return out;
        }
        parentId = parent.id;
        out.inferredBrand = await inferBrandFromFolder(parent, token);
      }
      // 事業が分かるので採番する（失敗しても作成は止めない＝番号なしで作る）
      if (out.inferredBrand) {
        try {
          out.seqLabel = formatSeq(await nextSeqNumber(env, out.inferredBrand));
        } catch {
          out.seqLabel = "";
        }
      }
      const name = out.seqLabel ? out.seqLabel + "_" + safeTitle : safeTitle;
      out.url = await createProjectFolderTree(name, parentId, token);
      out.created = true;
      return out;
    }

    // ここから先（新規・転用・相談・旧「改訂・流用」）は brand が必須
    const brandFolderId = DRIVE_BRAND_FOLDERS[brand];
    if (!brandFolderId) {
      out.reason = "対象事業・部署に対応するフォルダが見つかりません: " + (brand || "（未選択）");
      return out;
    }

    // 相談：02_案件管理/相談/ にフラットに置く。どの事業か分かるよう略称を前に付ける。
    if (category === "相談") {
      const name = "[" + brandShortName(brand) + "]_" + seqLabel + "_" + safeTitle;
      out.url = await createProjectFolderTree(name, DRIVE_SOUDAN_FOLDER_ID, token);
      out.created = true;
      return out;
    }

    // 【互換】旧「改訂・流用」：元データのURLが解けたら、その中に入れる（旧挙動の踏襲）
    if (category === "改訂・流用") {
      let parentId = brandFolderId;
      const revParent = await resolveKaiteiParent(data.sourceUrls, token);
      if (revParent) parentId = revParent.id;
      out.url = await createProjectFolderTree(seqLabel + "_" + safeTitle, parentId, token);
      out.created = true;
      return out;
    }

    // 新規・転用：事業フォルダ直下の種別フォルダ（棚）の中に作る。
    // 棚が解決できない（種別未選択・未知の種別）ときは事業フォルダ直下に置く。
    // ※転用の「転用元のデータ」URLは置き場所に使わない（元と並列に置く）＝V1-5.6確定
    const productTypes = asProductTypeList(data.productTypes);
    let parentId = brandFolderId;
    if (productTypes.length) {
      try {
        const shelfId = await resolveTypeShelf(brandFolderId, productTypes[0], token);
        if (shelfId) parentId = shelfId;
      } catch {
        // 棚の解決に失敗しても事業フォルダ直下に作る（フォルダなしよりよい）
      }
    }
    out.url = await createProjectFolderTree(seqLabel + "_" + safeTitle, parentId, token);
    out.created = true;
    return out;
  } catch (e) {
    out.reason = String(e.message || e);
    return out;
  }
}

// 作ったフォルダのURL等を Notion のプロパティに書き戻す。
// extra（任意）: { seqLabel, brand } … 改訂でDrive処理中に確定した値を追記する。
async function patchNotionStorageUrl(pageId, url, env, extra) {
  const version = (env.NOTION_VERSION || "2022-06-28").trim();
  const properties = { [DRIVE_STORAGE_PROP]: { url } };
  if (extra && extra.seqLabel) {
    properties[DRIVE_SEQ_PROP] = { rich_text: [{ text: { content: extra.seqLabel } }] };
  }
  if (extra && extra.brand) {
    properties["対象事業・部署"] = { select: { name: extra.brand } };
  }
  const res = await fetch("https://api.notion.com/v1/pages/" + pageId, {
    method: "PATCH",
    headers: {
      Authorization: "Bearer " + env.NOTION_TOKEN,
      "Notion-Version": version,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error("データ格納先の書き戻しに失敗: " + (body.message || res.status));
  }
}

// ページ本文の末尾に注記を1行足す（改訂でフォルダを作れなかったときの目印）。
// 失敗しても投げない（本文の注記は補助であり、依頼の成立を妨げない）。
async function appendNotionNote(pageId, text, env) {
  try {
    const version = (env.NOTION_VERSION || "2022-06-28").trim();
    await fetch("https://api.notion.com/v1/blocks/" + pageId + "/children", {
      method: "PATCH",
      headers: {
        Authorization: "Bearer " + env.NOTION_TOKEN,
        "Notion-Version": version,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        children: [{
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: String(text).slice(0, 2000) } }] },
        }],
      }),
    });
  } catch {
    // 何もしない
  }
}

// ---- V1-5.8 応答後処理（バックグラウンド） ----------------------

// アップロード済み画像をページ本文の末尾に追記する（見出し＋画像＋失敗注記）。
// ページ作成時と同じブロック構成（buildImageBlocks）を使う＝見た目は従来と変わらない。
async function appendImageBlocksToNotion(pageId, imageUploads, env) {
  const children = buildImageBlocks(imageUploads);
  if (!children.length) return;
  const version = (env.NOTION_VERSION || "2022-06-28").trim();
  const res = await fetch("https://api.notion.com/v1/blocks/" + pageId + "/children", {
    method: "PATCH",
    headers: {
      Authorization: "Bearer " + env.NOTION_TOKEN,
      "Notion-Version": version,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ children }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error("参考画像の追記に失敗: " + (body.message || res.status));
  }
}

// /submit の応答後に ctx.waitUntil で実行する後続処理のまとまり。
//   ① 参考画像：並列アップロード → 本文へ追記（失敗したら本文に⚠️注記）
//   ② Drive：フォルダ作成 → 「データ格納先」書き戻し（改訂の採番・事業もここで書く）
// ①②は互いに依存しないため並走させる。どれが失敗しても他は続行する
// （Promise.allSettled）。依頼そのもの（Notionページ）は応答時点で成立済み。
async function finishSubmitInBackground(data, images, notion, seqLabel, env) {
  const imagesJob = (async () => {
    if (!images.length) return;
    try {
      const uploads = await uploadImagesToNotion(images, env);
      await appendImageBlocksToNotion(notion.pageId, uploads, env);
    } catch {
      // アップロード枠の作成や本文追記が丸ごと失敗した場合の目印（依頼は成立している）
      await appendNotionNote(
        notion.pageId,
        "⚠️ 参考画像の掲載に失敗：" + images.length + "枚（お手数ですが元データを直接共有してください）",
        env,
      );
    }
  })();

  const driveJob = (async () => {
    // 従来と同じ実施条件：採番できた依頼か、改訂（採番はDrive処理の中で行う）
    if (!(seqLabel || data.category === "改訂")) return;
    const drive = await createDriveFolderForRequest(data, seqLabel, env);
    if (drive.created && drive.url) {
      try {
        await patchNotionStorageUrl(notion.pageId, drive.url, env, {
          // 改訂でDrive処理中に確定した値だけ追記する（それ以外は作成時に書いてある）
          seqLabel: data.category === "改訂" ? drive.seqLabel : "",
          brand: data.category === "改訂" ? drive.inferredBrand : "",
        });
      } catch {
        // 書き戻し失敗はフォルダURLがNotionに残らないだけ。フォルダ自体は作られている
      }
    } else if (data.category === "改訂" && !drive.created) {
      // フォルダを作れなかったことをページ本文に残す（ユウキが後から手で対処できるように）
      await appendNotionNote(
        notion.pageId,
        "⚠️ 改訂元の親フォルダにアクセスできなかったため、データ格納用フォルダは自動作成されていません（" +
          (drive.reason || "原因不明") + "）。お手数ですが手動で作成してください。",
        env,
      );
    }
  })();

  await Promise.allSettled([imagesJob, driveJob]);
}

// ---- ルーター ---------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request, env) });
    }

    // ⓪ ログイン：POST /auth/exchange
    //    フォームの自作ボタンで受け取った認可コードを、IDトークンに交換して返す。
    //    署名検証まで済ませてから返すので、フォーム側は結果を表示するだけでよい。
    if (request.method === "POST" && path === "/auth/exchange") {
      if (!isAllowedOrigin(request, env)) {
        return json({ error: "許可されていない送信元です" }, 403, request, env);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "データの形式が不正です" }, 400, request, env);
      }
      const code = body && typeof body.code === "string" ? body.code : "";
      if (!code) return json({ error: "認可コードがありません" }, 400, request, env);

      try {
        const idToken = await exchangeCodeForIdToken(code, env, request.headers.get("Origin"));
        const actor = await verifyGoogleIdToken(idToken, env);
        return json({
          ok: true,
          idToken,
          name: actor.name,
          email: actor.email,
          exp: actor.exp,
        }, 200, request, env);
      } catch (e) {
        if (e instanceof AuthError) {
          return json({ error: String(e.message || e), code: "AUTH" }, 403, request, env);
        }
        return json({ error: String(e.message || e) }, 500, request, env);
      }
    }

    // ① フォーム送信：POST /submit
    if (request.method === "POST" && path === "/submit") {
      if (!isAllowedOrigin(request, env)) {
        return json({ error: "許可されていない送信元です" }, 403, request, env);
      }
      if (!env.NOTION_TOKEN || !env.NOTION_DB_ID) {
        return json({ error: "サーバー設定が未完了です（NOTION_TOKEN / NOTION_DB_ID）" }, 500, request, env);
      }

      let data;
      try {
        data = await request.json();
      } catch {
        return json({ error: "データの形式が不正です" }, 400, request, env);
      }
      if (!data || !data.title || !data.category) {
        return json({ error: "依頼タイトル・依頼種別は必須です" }, 400, request, env);
      }

      // 【フェーズ3】再編集は廃止。開きっぱなしの旧編集画面（?edit）からの送信は明示的に断る
      if (typeof data.editId === "string" && data.editId) {
        return json({
          error: "再編集機能は終了しました。内容の修正は、お手数ですがNotionページ上で直接行ってください。",
          code: "EDIT_REMOVED",
        }, 410, request, env);
      }

      // Googleログイン検証（フェーズ1）：依頼者本人を特定する
      let actor;
      try {
        actor = await verifyGoogleIdToken(data.idToken, env);
        delete data.idToken; // 以降の処理・ログにトークンを残さない
      } catch (e) {
        if (e instanceof AuthError) {
          return json({ error: String(e.message || e), code: "AUTH" }, 403, request, env);
        }
        return json({ error: String(e.message || e) }, 500, request, env);
      }

      // 冪等キー
      const idem = typeof data.idempotencyKey === "string" ? data.idempotencyKey.slice(0, 64) : null;
      if (idem) {
        const cached = await env.REQUESTS.get("idem:" + idem);
        if (cached) return json(JSON.parse(cached), 200, request, env);
      }

      // 名前・メールは検証済みトークンからのみ採用する（手入力廃止・フェーズ1）
      data.requesterName = actor.name;
      data.requesterEmail = actor.email;

      // 【V1-5.7】改訂は「親フォルダが 02_案件管理 の事業フォルダ（または相談）配下にあること」を
      // 送信の成立条件にする。満たさない場合はNotionページを作らずに400で返し、
      // フォームが送信ボタン直下にエラーメッセージを表示する。
      // （散在する過去データの改訂は受けない＝その場合は依頼種別「転用」を使う運用・2026-08-11決定）
      if (data.category === "改訂") {
        const KAITEI_NG_HINT = "存在しない場合は、依頼種別を「転用」にして送信してください。";
        if (!extractDriveFolderId(data.sourceUrls)) {
          return json({
            error: "「改訂するデータの親フォルダのURL」が読み取れません。GoogleドライブのフォルダURLを貼り直してください。",
            code: "KAITEI_PARENT",
          }, 400, request, env);
        }
        let kaiteiParent = null;
        let kaiteiBrand = "";
        try {
          const token = await getDriveAccessToken(env);
          kaiteiParent = await resolveKaiteiParent(data.sourceUrls, token);
          if (kaiteiParent) kaiteiBrand = await inferBrandFromFolder(kaiteiParent, token);
        } catch (e) {
          return json({
            error: "親フォルダの確認に失敗しました。時間をおいてもう一度お試しください。（" + String(e.message || e) + "）",
            code: "KAITEI_PARENT",
          }, 503, request, env);
        }
        if (!kaiteiParent) {
          return json({
            error: "「CRAZY CREATIVE/02_案件管理」の中のフォルダURLを貼ってください。" + KAITEI_NG_HINT,
            code: "KAITEI_PARENT",
          }, 400, request, env);
        }
        if (!kaiteiBrand) {
          return json({
            error: "指定された親フォルダが「CRAZY CREATIVE/02_案件管理」の中にありません。02_案件管理の中にある改訂元のフォルダURLを貼ってください。" + KAITEI_NG_HINT,
            code: "KAITEI_PARENT",
          }, 400, request, env);
        }
        data._kaiteiParentId = kaiteiParent.id;
        data._kaiteiBrand = kaiteiBrand;
      }

      // ① 参考画像の検証だけ同期で行う（アップロードは応答後＝V1-5.8）
      const images = asImageList(data.images);

      // ②-a【V1-5】起票番号を採番する。
      //    対象事業・部署ごとの連番で、発番元は Notion（＝唯一の正本）。
      //    採番に失敗しても送信は止めない（番号なしでページだけ作る）。
      //    【V1-5.6】改訂はフォームに「対象事業・部署」が無いため、ここでは採番しない。
      //    Drive処理の中で親フォルダから事業を推定できたときだけ採番し、あとからNotionへ書き戻す。
      let seqLabel = "";
      if (data.brand && data.category !== "改訂") {
        try {
          seqLabel = formatSeq(await nextSeqNumber(env, data.brand));
        } catch {
          seqLabel = "";
        }
      }
      data.seqLabel = seqLabel;

      // ②-b Notionページ作成（唯一の正本）。
      //    【V1-5.8】画像は応答後にアップロードするため、ページは「画像なし」で先に作る。
      let notion;
      try {
        notion = await createNotionPage(data, { ids: [], failed: 0 }, env);
      } catch (e) {
        return json({ error: String(e.message || e) }, 502, request, env);
      }

      // 【V1-5.8】応答はここで確定する。フォームが使うのは notionUrl のみ。
      //   画像・Driveは応答後に処理するため、このレスポンス（と冪等キーの保存値）には
      //   最終結果が入らない。deferred:true がその目印。
      const result = {
        ok: true,
        notionUrl: notion.notionUrl,
        notionPageId: notion.pageId,
        seqLabel,
        imagesQueued: images.length,
        deferred: true, // 画像アップロード・Driveフォルダ作成は応答後に実行
      };
      if (idem) {
        await env.REQUESTS.put("idem:" + idem, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 7 });
      }

      // ②-c【V1-5.8】時間のかかる後続処理（画像・Drive）は応答後に回す。
      //    ctx.waitUntil に渡すことで、レスポンス返却後もWorkerが処理を続行できる。
      ctx.waitUntil(finishSubmitInBackground(data, images, notion, seqLabel, env));

      return json(result, 200, request, env);
    }

    // ②【廃止】GET /form/<id> … 開きっぱなしの旧編集画面向けの案内
    if (request.method === "GET" && path.startsWith("/form/")) {
      return json({
        error: "再編集機能は終了しました。内容の修正は、お手数ですがNotionページ上で直接行ってください。",
        code: "EDIT_REMOVED",
      }, 410, request, env);
    }

    // ③【移行措置】GET /v/<id> … Notionページへリダイレクト（記録が無ければ案内ページ）
    if (request.method === "GET" && path.startsWith("/v/")) {
      const id = path.slice(3);
      const rec = id ? await loadFormRecord(env, id) : null;
      const target = redirectTargetFor(rec);
      if (target) {
        return new Response(null, { status: 302, headers: { Location: target } });
      }
      return htmlResponse(buildGuideHtml(), 410);
    }

    // ④【V1-5・診断用】GET /drive/health
    //    Drive連携だけを切り離して、どの段階で失敗しているかを日本語で返す。
    //    実際にフォルダを1つ作って消すところまで試すので、権限不足も検出できる。
    //    秘密情報は返さない（メールアドレスの先頭だけ・鍵は長さのみ）。
    if (request.method === "GET" && path === "/drive/health") {
      const steps = [];
      const note = (label, ok, detail) => steps.push({ 手順: label, 結果: ok ? "OK" : "NG", 詳細: detail || "" });
      const email = (env.GOOGLE_SA_EMAIL || "").trim();
      const pem = env.GOOGLE_SA_PRIVATE_KEY || "";

      note("① GOOGLE_SA_EMAIL", !!email, email ? email.split("@")[0] + "@…" : "未設定");
      note(
        "② GOOGLE_SA_PRIVATE_KEY",
        pem.length > 1000 && pem.indexOf("BEGIN PRIVATE KEY") !== -1 && pem.indexOf("END PRIVATE KEY") !== -1,
        "長さ " + pem.length + "文字／BEGIN " + (pem.indexOf("BEGIN PRIVATE KEY") !== -1) +
          "／END " + (pem.indexOf("END PRIVATE KEY") !== -1) +
          "／改行 " + ((pem.match(/\n/g) || []).length) + "個／\\nリテラル " + ((pem.match(/\\n/g) || []).length) + "個",
      );
      if (!email || !pem) {
        return json({ ok: false, 診断: steps, 次の一手: "Secretが未登録です。npx wrangler secret put で登録してください" }, 200, request, env);
      }

      let token = "";
      try {
        token = await getDriveAccessToken(env);
        note("③ アクセストークンの取得", true, "成功");
      } catch (e) {
        note("③ アクセストークンの取得", false, String(e.message || e));
        return json({ ok: false, 診断: steps, 次の一手: "鍵の中身が壊れているか、サービスアカウントが無効です。STEP5をやり直してください" }, 200, request, env);
      }

      try {
        const parent = await getDriveFile(DRIVE_KANRI_FOLDER_ID, token);
        note("④ 02_案件管理 の読み取り", true, parent.name);
      } catch (e) {
        const msg = String(e.message || e);
        note("④ 02_案件管理 の読み取り", false, msg);
        // 原因が2つあり、対処が正反対なので文言を出し分ける
        const hint = /has not been used in project|is disabled|accessNotConfigured/.test(msg)
          ? "GCPで Google Drive API が有効化されていません。上記URLを開いて「有効にする」を押し、2〜3分待ってから再実行してください"
          : "共有ドライブ CRAZY CREATIVE にサービスアカウントが追加されていません（STEP4）";
        return json({ ok: false, 診断: steps, 次の一手: hint }, 200, request, env);
      }

      let tempId = "";
      try {
        const tmp = await createDriveFolder("_接続テスト_自動削除されます", DRIVE_SOUDAN_FOLDER_ID, token);
        tempId = tmp.id;
        note("⑤ フォルダの作成", true, tmp.name);
      } catch (e) {
        note("⑤ フォルダの作成", false, String(e.message || e));
        return json({ ok: false, 診断: steps, 次の一手: "読めるが書けない状態です。共有ドライブでの権限を「コンテンツ管理者」にしてください（STEP4）" }, 200, request, env);
      }

      try {
        // 共有ドライブでは DELETE（完全削除）は「管理者」権限が要る。
        // 「コンテンツ管理者」でもできる “ゴミ箱に入れる”（trashed:true）を使う。
        const res = await fetch(DRIVE_API + "/" + tempId + "?supportsAllDrives=true", {
          method: "PATCH",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ trashed: true }),
        });
        note("⑥ テストフォルダの後片付け", res.ok, res.ok ? "ゴミ箱へ移動済み" : "HTTP " + res.status + "（相談フォルダに残っています。手で消してください）");
      } catch (e) {
        note("⑥ テストフォルダの後片付け", false, String(e.message || e));
      }

      return json({ ok: true, 診断: steps, 次の一手: "Drive連携は正常です。フォームから送信してください" }, 200, request, env);
    }

    // 稼働確認
    if (request.method === "GET" && path === "/") {
      return htmlResponse("creative-process Worker は稼働中です。");
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders(request, env) });
  },
};

// ---- テスト用エクスポート（test/unit.test.mjs から参照。動作には影響しない） ----
export {
  sectionsFor,
  asImageList,
  asScheduleList,
  asProductTypeList,
  redirectTargetFor,
  buildGuideHtml,
  buildNotionProperties,
  buildNotionSectionBlocks,
  buildNotionBlocks,
  // 【V1-5.8】起票高速化（画像ブロックの切り出し＝応答後の本文追記で共用）
  buildImageBlocks,
  // 【V1-5】Drive自動フォルダ作成
  brandShortName,
  formatSeq,
  parseSeq,
  sanitizeFolderName,
  extractDriveFolderId,
  importServiceAccountKey,
  b64urlFromString,
  b64urlFromBytes,
  DRIVE_BRAND_FOLDERS,
  DRIVE_SOUDAN_FOLDER_ID,
  DRIVE_SUBFOLDERS,
  SEC_YOKEN,
  SEC_SEISAKU,
  SEC_SOUDAN,
  SEC_KAITEI,
  // 【V1-5.6】改訂／転用の分離・種別フォルダ（棚）
  SEC_TENYO,
  SEC_KAITEI_LEGACY,
  DRIVE_TYPE_SHELVES,
  DRIVE_FOLDER_TO_BRAND,
  NUMBERED_FOLDER_RE,
  // 【V1-5.7】改訂の親フォルダを02_案件管理内に限定
  DRIVE_KANRI_FOLDER_ID,
  brandFromShortName,
};
