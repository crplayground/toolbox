// ============================================================
// creative-process Worker（制作依頼ツール／フェーズ3: Notion一本化）
// ------------------------------------------------------------
// 役割：依頼フォーム（静的HTML）から送られた1件の依頼を、サーバー側で一括処理する。
//   ① Notion DB にページを作成（プロパティ＋本文全文＋参考画像）＝唯一の正本
//   ② Slack 受付ch（#83_creative_クリ室依頼受付）へ Incoming Webhook で投稿
//      （初依頼者なら「🆕要ゲスト招待」を付記。フェーズ4先行分としてBlock Kit整形済み）
//
// フェーズ3（Notion一本化・2026-07）：
//   - 共有URL（/v/<id>）の発行を廃止。依頼の正本は Notion ページただ1つ。
//   - フェーズ2の再編集機構（form:<id>復元・?edit・更新版追記）を撤去。
//     内容の修正は Notion ページ上で直接行う（履歴は Notion のページ履歴が担う）。
//   - 参考画像は Notion File Upload API でページ本文に埋め込む（共有HTML廃止の代替）。
//     アップロードに失敗した分は本文に「⚠️失敗N枚」と記録し、送信自体は成功させる。
//   - 初依頼者検知：依頼者メールを KV の既知リスト guest:<email> と照合し、
//     未知なら Slack 投稿に「🆕要ゲスト招待」を付記する。
//     既知マークは「Slack投稿が実際に成功したときだけ」付ける（通知の取りこぼし防止。
//     見落としても Notion 標準の「アクセスのリクエスト」承認が二層目の安全網になる）。
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
//   POST /submit    … フォーム送信。{ ok, notionUrl, notionPageId, slackPosted, firstRequest } を返す
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
//   SLACK_WEBHOOK_URL （任意）受付chのIncoming Webhook。未設定ならSlack投稿はスキップ
//                      ※未設定の間は初依頼者の「既知マーク」も付けない（通知が飛ばないため）
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
// KVキー（binding=REQUESTS）：
//   idem:<key>     冪等キー（二重送信防止・7日保持）
//   guest:<email>  既知依頼者リスト（恒久保存・フェーズ3新設）
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
// 改訂・流用は専用の最小構成（元データ＝URL配列／概要）
const SEC_KAITEI = [
  ["sourceUrls", "改訂・流用元のデータ"],
  ["reviseManuscript", "制作内容"],
];

// 依頼種別 → 表示する長文セクション
function sectionsFor(category) {
  if (category === "相談") return SEC_SOUDAN;
  if (category === "改訂・流用") return SEC_KAITEI;
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
// ブラウザには一切渡さない。ポップアップ方式なので redirect_uri は "postmessage" を使う。
async function exchangeCodeForIdToken(code, env) {
  const clientId = (env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    throw new Error("サーバー設定が未完了です（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）");
  }
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    redirect_uri: "postmessage",
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.id_token) {
    // Googleのエラー内容はそのまま返さない（設定情報が漏れるため）
    throw new AuthError("ログインに失敗しました。もう一度お試しください");
  }
  return out.id_token;
}

// ---- 既知依頼者リスト（フェーズ3・ゲスト運用） -------------------
// KV guest:<email> に「一度でも依頼したことがある人」を記録する。
// 未知の人＝初依頼者。Slack投稿に「🆕要ゲスト招待」を付記して宮川へ知らせる。
// 招待そのものは Notion に招待APIが無いため手動（DB単位・1人生涯1回で収束）。

function normEmail(v) {
  return String(v == null ? "" : v).trim().toLowerCase();
}
function guestKey(email) {
  const e = normEmail(email);
  return e ? "guest:" + e : "";
}
async function isKnownGuest(env, email) {
  const k = guestKey(email);
  if (!k) return true; // メール不明は「通知不要」扱い（通常は起こらない）
  return (await env.REQUESTS.get(k)) !== null;
}
async function markGuestKnown(env, email, name) {
  const k = guestKey(email);
  if (!k) return;
  // 恒久保存（TTLなし）。値は運用確認用のメモ程度
  await env.REQUESTS.put(k, JSON.stringify({
    email: normEmail(email),
    name: name || "",
    firstSeenAt: Date.now(),
  }));
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
    "<p>依頼の内容は、Slack の受付チャンネル <b>#83_creative_クリ室依頼受付</b> の該当投稿にある Notion リンクから確認できます。</p>" +
    "<p class=\"note\">見つからない場合は、クリエイティブ室（宮川）までお知らせください。</p>" +
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

// ページ本文全体（セクション本文 → 参考画像）。
// imageUploads = { ids: [file_upload_id...], failed: 失敗枚数 }（uploadImagesToNotion の結果）
function buildNotionBlocks(data, imageUploads) {
  const blocks = buildNotionSectionBlocks(data);
  const up = imageUploads || { ids: [], failed: 0 };
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
  const ids = [];
  let failed = 0;
  for (let i = 0; i < images.length; i++) {
    try {
      const id = await uploadOneImageToNotion(images[i], i, env);
      if (id) ids.push(id);
      else failed++;
    } catch {
      failed++;
    }
  }
  return { ids, failed };
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

// ---- Slack 投稿（任意） ----------------------------------------
// 【フェーズ4先行分（2026-07-25）】投稿をBlock Kitで整形（Webhookのままで実装可能な範囲）。
//   - buildSlackBlocks … 本体の見た目（ヘッダー・概要フィールド・Notionボタン・🆕招待案内）
//   - buildSlackText   … 通知バナー・プッシュ通知用のfallbackテキスト（blocks非対応環境の保険）
// firstRequest=true なら「🆕初依頼者・要ゲスト招待」を付記する（フェーズ3）。
// ※スレッド化・自動メンション・投稿URLのNotion記録はBotトークンが必要（フェーズ4本体）。

// 依頼カテゴリ→絵文字（ひと目で種別が分かるように）
const CATEGORY_EMOJI = { "新規": "🎨", "改訂・流用": "♻️", "相談": "💬" };

function buildSlackText(data, notionUrl, firstRequest) {
  const productTypes = asProductTypeList(data.productTypes);
  const imgCount = asImageList(data.images).length;
  const category = data.category || "種別未設定";
  const emoji = CATEGORY_EMOJI[category] || "📩";
  const lines = [
    emoji + " *制作依頼を受け付けました*［" + category + "］",
    "依頼タイトル: " + (data.title || "（無題）"),
    data.brand ? "対象事業/部署: " + data.brand : null,
    data.requesterDept ? "所属部署: " + data.requesterDept : null,
    productTypes.length ? "制作物の種別: " + productTypes.join("、") : null,
    data.requesterName ? "依頼者: " + data.requesterName : null,
    imgCount ? "添付画像: " + imgCount + "枚（Notionページに掲載）" : null,
    notionUrl ? "Notion: " + notionUrl : null,
  ].filter(Boolean);
  if (firstRequest) {
    lines.push(
      "🆕 初依頼の方です。" + (data.requesterName || "依頼者") + " さん（" + normEmail(data.requesterEmail) + "）を" +
      "「クリエイティブプロジェクト」DBにゲスト招待してください（DB右上「共有」→メールを入力→「今はスキップ」）。招待は1人1回だけでOKです。"
    );
  }
  return lines.join("\n");
}

// Block Kit本体。Incoming Webhookは blocks に対応している（インタラクティブ要素は
// 使えないが、URLを開くだけの「リンクボタン」は動作する）。
function buildSlackBlocks(data, notionUrl, firstRequest) {
  const productTypes = asProductTypeList(data.productTypes);
  const imgCount = asImageList(data.images).length;
  const category = data.category || "種別未設定";
  const emoji = CATEGORY_EMOJI[category] || "📩";
  const title = data.title || "（無題）";

  const blocks = [];

  // ① ヘッダー（plain_text限定・最大150字）
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: (emoji + " " + title).slice(0, 150), emoji: true },
  });

  // ② 概要フィールド（2列で並ぶ。空の項目は出さない・最大10件）
  const fields = [
    { type: "mrkdwn", text: "*依頼種別*\n" + category },
    data.requesterName
      ? { type: "mrkdwn", text: "*依頼者*\n" + data.requesterName + (data.requesterDept ? "（" + data.requesterDept + "）" : "") }
      : null,
    data.brand ? { type: "mrkdwn", text: "*対象事業・部署*\n" + data.brand } : null,
    productTypes.length ? { type: "mrkdwn", text: "*制作物の種別*\n" + productTypes.join("、").slice(0, 1900) } : null,
    imgCount ? { type: "mrkdwn", text: "*添付画像*\n" + imgCount + "枚（Notionページに掲載）" } : null,
  ].filter(Boolean).slice(0, 10);
  blocks.push({ type: "section", fields });

  // ③ Notionページへのリンクボタン（依頼の正本へ最短導線）
  if (notionUrl) {
    blocks.push({
      type: "actions",
      elements: [{
        type: "button",
        text: { type: "plain_text", text: "🗂 Notionで依頼内容を見る", emoji: true },
        url: notionUrl,
        style: "primary",
      }],
    });
  }

  // ④ 初依頼者の招待案内（フェーズ3の🆕検知をBlock Kitで表示）
  if (firstRequest) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "🆕 *初依頼の方です。* " + (data.requesterName || "依頼者") + " さん（`" + normEmail(data.requesterEmail) + "`）を" +
          "「クリエイティブプロジェクト」DBにゲスト招待してください（DB右上「共有」→メールを入力→「今はスキップ」）。招待は1人1回だけでOKです。",
      },
    });
  }

  return blocks;
}

async function postToSlack(data, notionUrl, firstRequest, env) {
  const hook = (env.SLACK_WEBHOOK_URL || "").trim();
  if (!hook) return { posted: false, reason: "SLACK_WEBHOOK_URL未設定" };
  const res = await fetch(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: buildSlackText(data, notionUrl, firstRequest), // 通知用fallback
      blocks: buildSlackBlocks(data, notionUrl, firstRequest),
    }),
  });
  return { posted: res.ok, reason: res.ok ? "" : "Slack投稿HTTP " + res.status };
}

// ============================================================
// Google Drive 自動フォルダ作成（V1-5）
// ------------------------------------------------------------
// 依頼1件につき、共有ドライブ「CRAZY CREATIVE」の 02_案件管理 配下に
// 案件フォルダ（＋3点セットのサブフォルダ）を作り、そのURLを
// Notion の「データ格納先」プロパティに書き戻す。
//
// 置き場所のルール：
//   新規       … 02_案件管理/<対象事業・部署>/no00001_タイトル
//   改訂・流用 … 上の案件フォルダの中に no00033_タイトル（＝2階層で止める）
//                 ※「改訂・流用元のデータ」に貼られたDrive URLから親を特定する。
//                   URLが無い／解析できない／別ブランドを指している場合は新規と同じ位置に作る。
//   相談       … 02_案件管理/相談/[対象事業・部署の略称]_no00005_タイトル（フラット）
//
// 起票番号（no00001）のルール：
//   - 対象事業・部署ごとの独立した連番。IWAIの00001とCGMの00001は別物。
//   - 発番元は Notion。DBを「対象事業・部署＝そのブランド」で絞り、
//     「起票番号」の最大値を取って +1 する（＝Notionが唯一の正本という方針に合わせる）。
//   - 常に5桁ゼロ埋め。文字列のまま比較しても数値順になる。
//   - Notionページを消すと欠番になる（最大値方式のため）。運用上の実害はない。
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

// 「相談」の置き場。02_案件管理 直下（2026-08-06作成）。
const DRIVE_SOUDAN_FOLDER_ID = "1_YbqkpMimOFM5_zMF91YqQqw2jH38zvu";

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

// 改訂・流用の親を決める。貼られたURLが「改訂フォルダ」だった場合は親をたどり、
// ブランド直下の案件フォルダまで引き上げる（＝入れ子は2階層で止める）。
// たどれない・別ブランドを指している場合は null を返し、呼び出し側が新規と同じ扱いにする。
async function resolveRevisionParent(sourceUrl, brandFolderId, token) {
  const startId = extractDriveFolderId(sourceUrl);
  if (!startId || !brandFolderId) return null;

  let node;
  try {
    node = await getDriveFile(startId, token);
  } catch {
    return null;
  }
  // フォルダのURLではなくファイルのURLが貼られていたら、その入れ物から始める
  if (node.mimeType !== "application/vnd.google-apps.folder") {
    const up = (node.parents || [])[0];
    if (!up) return null;
    try {
      node = await getDriveFile(up, token);
    } catch {
      return null;
    }
  }

  // 最大5段さかのぼって「親がブランドフォルダ」になる階層を探す
  for (let i = 0; i < 5; i++) {
    const parent = (node.parents || [])[0];
    if (!parent) return null;
    if (parent === brandFolderId) return node.id;
    if (parent === DRIVE_SOUDAN_FOLDER_ID) return node.id; // 相談から発生した案件
    try {
      node = await getDriveFile(parent, token);
    } catch {
      return null;
    }
  }
  return null;
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
async function createDriveFolderForRequest(data, seqLabel, env) {
  const out = { created: false, url: "", reason: "" };
  if (!(env.GOOGLE_SA_EMAIL || "").trim() || !env.GOOGLE_SA_PRIVATE_KEY) {
    out.reason = "Drive未設定（GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY）";
    return out;
  }
  const brand = String(data.brand || "").trim();
  const brandFolderId = DRIVE_BRAND_FOLDERS[brand];
  if (!brandFolderId) {
    out.reason = "対象事業・部署に対応するフォルダが見つかりません: " + (brand || "（未選択）");
    return out;
  }

  try {
    const token = await getDriveAccessToken(env);
    const safeTitle = sanitizeFolderName(data.title);

    // 相談：02_案件管理/相談/ にフラットに置く。どの事業か分かるよう略称を前に付ける。
    if (data.category === "相談") {
      const name = "[" + brandShortName(brand) + "]_" + seqLabel + "_" + safeTitle;
      out.url = await createProjectFolderTree(name, DRIVE_SOUDAN_FOLDER_ID, token);
      out.created = true;
      return out;
    }

    // 改訂・流用：元データのURLが解けたら、その案件フォルダの中に入れる
    let parentId = brandFolderId;
    if (data.category === "改訂・流用") {
      const revParent = await resolveRevisionParent(data.sourceUrls, brandFolderId, token);
      if (revParent) parentId = revParent;
    }
    out.url = await createProjectFolderTree(seqLabel + "_" + safeTitle, parentId, token);
    out.created = true;
    return out;
  } catch (e) {
    out.reason = String(e.message || e);
    return out;
  }
}

// 作ったフォルダのURLを Notion の「データ格納先」に書き戻す。
async function patchNotionStorageUrl(pageId, url, env) {
  const version = (env.NOTION_VERSION || "2022-06-28").trim();
  const res = await fetch("https://api.notion.com/v1/pages/" + pageId, {
    method: "PATCH",
    headers: {
      Authorization: "Bearer " + env.NOTION_TOKEN,
      "Notion-Version": version,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties: { [DRIVE_STORAGE_PROP]: { url } } }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error("データ格納先の書き戻しに失敗: " + (body.message || res.status));
  }
}

// ---- ルーター ---------------------------------------------------
export default {
  async fetch(request, env) {
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
        const idToken = await exchangeCodeForIdToken(code, env);
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

      // 【フェーズ3】初依頼者かどうかを既知リストと照合
      let firstRequest = false;
      try {
        firstRequest = !(await isKnownGuest(env, actor.email));
      } catch {
        firstRequest = false; // 照合に失敗しても送信は止めない（安全網＝アクセスリクエスト承認）
      }

      // ① 参考画像を Notion にアップロード（失敗しても致命にしない）
      const images = asImageList(data.images);
      let uploads = { ids: [], failed: 0 };
      if (images.length) {
        uploads = await uploadImagesToNotion(images, env);
      }

      // ②-a【V1-5】起票番号を採番する。
      //    対象事業・部署ごとの連番で、発番元は Notion（＝唯一の正本）。
      //    採番に失敗しても送信は止めない（番号なしでページだけ作る）。
      let seqLabel = "";
      if (data.brand) {
        try {
          seqLabel = formatSeq(await nextSeqNumber(env, data.brand));
        } catch {
          seqLabel = "";
        }
      }
      data.seqLabel = seqLabel;

      // ②-b Notionページ作成（唯一の正本）
      let notion;
      try {
        notion = await createNotionPage(data, uploads, env);
      } catch (e) {
        return json({ error: String(e.message || e) }, 502, request, env);
      }

      // ②-c【V1-5】Driveに案件フォルダ（＋3点セット）を作り、URLを「データ格納先」に書き戻す。
      //    任意処理。失敗しても依頼そのものは成立させ、依頼者に再送信させない。
      let drive = { created: false, url: "", reason: "起票番号が採れなかったためスキップ" };
      if (seqLabel) {
        drive = await createDriveFolderForRequest(data, seqLabel, env);
        if (drive.created && drive.url) {
          try {
            await patchNotionStorageUrl(notion.pageId, drive.url, env);
          } catch (e) {
            drive.reason = String(e.message || e);
          }
        }
      }

      // ③ Slack投稿（任意・失敗しても致命にしない）
      let slack = { posted: false, reason: "" };
      try {
        slack = await postToSlack(data, notion.notionUrl, firstRequest, env);
      } catch (e) {
        slack = { posted: false, reason: String(e.message || e) };
      }

      // ④ 既知マークは「初依頼者の通知が実際に投稿できたとき」だけ付ける。
      //    （Webhook未設定・投稿失敗のときは付けず、次回の送信で再通知させる）
      if (firstRequest && slack.posted) {
        try { await markGuestKnown(env, actor.email, actor.name); } catch {}
      }

      const result = {
        ok: true,
        notionUrl: notion.notionUrl,
        notionPageId: notion.pageId,
        slackPosted: slack.posted,
        slackNote: slack.reason,
        firstRequest,
        imagesUploaded: uploads.ids.length,
        imagesFailed: uploads.failed,
        // 【V1-5】Drive自動フォルダ作成の結果（フォームは今のところ表示しない）
        seqLabel,
        driveFolderUrl: drive.url,
        driveCreated: drive.created,
        driveNote: drive.reason,
      };
      if (idem) {
        await env.REQUESTS.put("idem:" + idem, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 7 });
      }
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
  normEmail,
  guestKey,
  redirectTargetFor,
  buildGuideHtml,
  buildNotionProperties,
  buildNotionSectionBlocks,
  buildNotionBlocks,
  buildSlackText,
  buildSlackBlocks,
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
  CATEGORY_EMOJI,
  SEC_YOKEN,
  SEC_SEISAKU,
  SEC_SOUDAN,
  SEC_KAITEI,
};
