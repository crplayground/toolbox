// ============================================================
// creative-request Worker（制作依頼ツール／フェーズ3: Notion一本化）
// ------------------------------------------------------------
// 役割：依頼フォーム（静的HTML）から送られた1件の依頼を、サーバー側で一括処理する。
//   ① Notion DB にページを作成（プロパティ＋本文全文＋参考画像）＝唯一の正本
//   ② Slack 受付ch（#83_creative_クリ室依頼受付）へ Incoming Webhook で投稿
//      （初依頼者なら「🆕要ゲスト招待」を付記）
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
//   GOOGLE_CLIENT_ID  （必須）GISのOAuthクライアントID。IDトークンの aud 検証に使用
//   SLACK_WEBHOOK_URL （任意）受付chのIncoming Webhook。未設定ならSlack投稿はスキップ
//                      ※未設定の間は初依頼者の「既知マーク」も付けない（通知が飛ばないため）
//   ALLOWED_ORIGIN    （任意）許可するフォームのオリジン。カンマ区切り可。未設定なら全許可
//   NOTION_VERSION    （任意）Notion APIバージョン。未設定なら "2022-06-28"
//
// KVキー（binding=REQUESTS）：
//   idem:<key>     冪等キー（二重送信防止・7日保持）
//   guest:<email>  既知依頼者リスト（恒久保存・フェーズ3新設）
//   form:<id> / html:<id>  フェーズ2以前の残置データ（新規保存はしない。TTLで自然消滅）
// ============================================================

// ---- 種別ごとの「長文与件」項目（フォームのname → 見出しラベル） ----
// Notion本文の見出し構成に使う。順序＝表示順。
const SEC_YOKEN = [
  ["purpose", "依頼の目的"],
  ["issue", "現状の課題"],
  ["target", "ターゲット"],
  ["overview", "依頼概要"],
  ["useDate", "実施日・使用開始日"],
  ["usePlace", "使用場所・使用シーン"],
  ["outcome", "得たい成果"],
  ["afterFeeling", "体験後や読後感の感情"],
  ["budget", "予算感"],
];
const SEC_SEISAKU = [
  ["manuscript", "原稿"],
  ["prototype", "プロトタイプ"],
  ["reference", "参考・インスピレーション"],
  ["intent", "依頼意図（想い・情熱）"],
  ["prStatus", "企画について広報チームの確認状況"],
];
const SEC_SOUDAN = [
  ["consultDetail", "相談内容"],
];
// 改訂は専用の最小構成（改訂元のデータ＝URL配列／原稿）
const SEC_KAITEI = [
  ["sourceUrls", "改訂元のデータ"],
  ["reviseManuscript", "原稿（コピペできるように）"],
];

// 依頼カテゴリ → 表示する長文セクション
function sectionsFor(category) {
  if (category === "相談") return SEC_SOUDAN;
  if (category === "改訂") return SEC_KAITEI;
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
  return { name: String(payload.name || "") || email, email };
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
    "<p>制作依頼の内容は、現在は Notion の「案件管理」データベースにのみ保存されています。このURLでの共有ページは公開を終了しました。</p>" +
    "<p>依頼の内容は、Slack の受付チャンネル <b>#83_creative_クリ室依頼受付</b> の該当投稿にある Notion リンクから確認できます。</p>" +
    "<p class=\"note\">見つからない場合は、クリエイティブ室（宮川）までお知らせください。</p>" +
    "</div></body></html>"
  );
}

// ---- Notion 登録 ------------------------------------------------
// 最小プロパティ＋ページ本文（長文与件・スケジュール感・参考画像）。
// ※プロパティ名は DB「案件管理」の確定名に合わせている。名称変更時はここを直す。
function buildNotionProperties(data) {
  const props = {
    "案件名": { title: [{ text: { content: (data.title || "（無題）").slice(0, 2000) } }] },
    "依頼カテゴリ": { select: { name: data.category || "相談" } },
  };

  const productTypes = asProductTypeList(data.productTypes);

  if (data.brand) props["対象ブランド・部署"] = { select: { name: data.brand } };
  if (productTypes.length) props["制作物の種別"] = { multi_select: productTypes.map((n) => ({ name: n })) };
  if (data.requesterDept) props["依頼者部署"] = { select: { name: data.requesterDept } };
  if (data.requesterName) props["依頼者名"] = { rich_text: [{ text: { content: data.requesterName } }] };
  if (data.requesterEmail) props["依頼者メール"] = { email: data.requesterEmail };
  if (data.deadline) props["希望納期"] = { date: { start: data.deadline } };
  if (data.dataStorage) props["データ格納先"] = { url: data.dataStorage };

  return props;
}

// 長文与件のセクション本文ブロック（見出し＋本文＋スケジュール感）を組み立てる。
function buildNotionSectionBlocks(data) {
  const blocks = [];
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
  // スケジュール感（マイルストーン）：本文へ箇条書きで（プロパティには入れない）
  const schedule = asScheduleList(data.schedule);
  if (schedule.length) {
    blocks.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: "スケジュール感" } }] },
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
// firstRequest=true なら「🆕初依頼者・要ゲスト招待」を付記する（フェーズ3）。
function buildSlackText(data, notionUrl, firstRequest) {
  const productTypes = asProductTypeList(data.productTypes);
  const imgCount = asImageList(data.images).length;
  const lines = [
    "*新規の制作依頼*［" + (data.category || "種別未設定") + "］",
    "案件名: " + (data.title || "（無題）"),
    data.deadline ? "希望納期: " + data.deadline : null,
    data.brand ? "対象ブランド/部署: " + data.brand : null,
    data.requesterDept ? "依頼者部署: " + data.requesterDept : null,
    productTypes.length ? "制作物の種別: " + productTypes.join("、") : null,
    data.requesterName ? "依頼者: " + data.requesterName : null,
    imgCount ? "添付画像: " + imgCount + "枚（Notionページに掲載）" : null,
    notionUrl ? "Notion: " + notionUrl : null,
  ].filter(Boolean);
  if (firstRequest) {
    lines.push(
      "🆕 初依頼の方です。" + (data.requesterName || "依頼者") + " さん（" + normEmail(data.requesterEmail) + "）を" +
      "案件管理DBにゲスト招待してください（DB右上「共有」→メールを入力→「今はスキップ」）。招待は1人1回だけでOKです。"
    );
  }
  return lines.join("\n");
}

async function postToSlack(data, notionUrl, firstRequest, env) {
  const hook = (env.SLACK_WEBHOOK_URL || "").trim();
  if (!hook) return { posted: false, reason: "SLACK_WEBHOOK_URL未設定" };
  const res = await fetch(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: buildSlackText(data, notionUrl, firstRequest) }),
  });
  return { posted: res.ok, reason: res.ok ? "" : "Slack投稿HTTP " + res.status };
}

// ---- ルーター ---------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request, env) });
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
        return json({ error: "案件名・依頼カテゴリは必須です" }, 400, request, env);
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

      // ② Notionページ作成（唯一の正本）
      let notion;
      try {
        notion = await createNotionPage(data, uploads, env);
      } catch (e) {
        return json({ error: String(e.message || e) }, 502, request, env);
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
      return htmlResponse("creative-request Worker は稼働中です。");
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
  SEC_YOKEN,
  SEC_SEISAKU,
  SEC_SOUDAN,
  SEC_KAITEI,
};
