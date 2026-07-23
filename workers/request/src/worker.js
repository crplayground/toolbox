// ============================================================
// creative-request Worker（制作依頼ツール v1 の受け口）
// ------------------------------------------------------------
// 役割：依頼フォーム（静的HTML）から送られた1件の依頼を、サーバー側で一括処理する。
//   ① KVに「共有HTML」を保存 → 社内共有URL /v/<id> を発行
//   ② Notion DB に最小プロパティ＋共有URL を登録し、長文与件はページ本文へ転記
//   ③ Slack 受付ch（#83_creative_クリ室依頼受付）へ Incoming Webhook で投稿
//
// 設問は「v1-notionプロパティ一覧-修正_2026-06-14.csv」に準拠（2026-06-15 改訂）。
//   - Notionプロパティ：案件名/依頼カテゴリ/対象ブランド・部署/制作物の種別/依頼者部署/依頼者名/依頼者メール/希望納期/データ格納先（共有URLは本文calloutのみ）
//   - 長文与件（与件整理・制作内容・相談）はKVのHTML共有ページ＋Notionページ本文へ
//
// 設計の肝（BRIEF.md 3章・5章）：
//   - 鍵はブラウザに置かない。Notionトークン／Slack Webhook URL は Worker環境変数で保持。
//   - 二重送信は冪等キー（idempotencyKey）で防止。
//   - POST は ALLOWED_ORIGIN で発信元を制限する。
//
// エンドポイント：
//   POST /submit    … フォーム送信。新規は作成、editId 付きは既存依頼の上書き更新。
//                      { ok, id, shareUrl, notionUrl, slackPosted, edited } を返す
//   GET  /form/<id> … 【フェーズ2】再編集用に保存済みフォームJSONを返す（要ログイン・権限判定）
//   GET  /v/<id>    … 保存した共有HTMLを表示（v1は閲覧制限なし）
//   GET  /          … 稼働確認
//
// 環境変数（Secrets / Vars）：
//   NOTION_TOKEN           （必須）Notion インテグレーションのトークン
//   NOTION_DB_ID           （必須）登録先DBの database_id
//   GOOGLE_CLIENT_ID       （必須・フェーズ1）GISのOAuthクライアントID。IDトークンの aud 検証に使用
//   SLACK_WEBHOOK_URL      （任意）受付chのIncoming Webhook。未設定ならSlack投稿はスキップ
//   ALLOWED_ORIGIN         （任意）許可するフォームのオリジン。カンマ区切り可。未設定なら全許可
//   NOTION_VERSION         （任意）Notion APIバージョン。未設定なら "2022-06-28"
//   FORM_URL               （任意・フェーズ2）フォームの公開URL。共有ページの編集ボタンに使う
//   CREATIVE_EDITOR_EMAILS （任意・フェーズ2）依頼者本人に加えて再編集を許可するメール（カンマ区切り）。
//                          クリ室メンバーを入れる。機密ではないが Secret 管理推奨（公開リポ回避）
//
// フェーズ2（再編集・2026-07）：
//   /submit 時に「共有HTML」に加えて「フォームJSON」も form:<id> としてKVに保存する。
//   これを /form/<id> で復元してフォームにプリフィルし、同じIDで上書き更新（共有URLは不変）。
//   編集できるのは「依頼者本人（保存メールと一致）＋ CREATIVE_EDITOR_EMAILS の許可メール」。
//   依頼者名・メールは原本を保持（クリ室が代理編集しても依頼者はすり替わらない）。
//   Notion はプロパティをPATCH更新し、本文は上書きせず「🔄 更新版」を追記する（事故リスク回避）。
//
// フェーズ1（Googleログイン・2026-07）：
//   フォームは名前・メールを手入力せず、GISのIDトークン（JWT）を idToken として送る。
//   Worker は Google の公開鍵（JWKS）で署名を検証し、iss / aud / exp / hd=crazy.co.jp /
//   email_verified を確認したうえで、名前・メールをトークンから取り出して使う。
//   クライアントが送ってきた requesterName / requesterEmail は一切信用しない。
// ============================================================

// ---- 種別ごとの「長文与件」項目（フォームのname → 見出しラベル） ----
// 共有HTML／Notion本文の見出し構成に使う。順序＝表示順。
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
  // フェーズ2：/form/<id> は Authorization ヘッダ（Bearer IDトークン）を使うため許可に追加
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ---- 小物ユーティリティ ----------------------------------------

function makeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
}

// フェーズ2：フォームJSONの保存・読み出し（再編集の元データ）。1年保持。
const FORM_TTL = 60 * 60 * 24 * 365;
async function saveFormRecord(env, id, record) {
  await env.REQUESTS.put("form:" + id, JSON.stringify(record), { expirationTtl: FORM_TTL });
}
async function loadFormRecord(env, id) {
  const raw = await env.REQUESTS.get("form:" + id);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// フェーズ2：フォームの編集URL（?edit=<id>）を作る。FORM_URL 未設定時は既定の公開URLを使う。
const DEFAULT_FORM_URL = "https://crplayground.github.io/toolbox/request/";
function buildEditUrl(env, id) {
  let base = (env.FORM_URL || DEFAULT_FORM_URL).trim().split("#")[0];
  const sep = base.indexOf("?") === -1 ? "?" : "&";
  return base + sep + "edit=" + encodeURIComponent(id);
}

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

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isAllowedOrigin(request, env) {
  const allow = (env.ALLOWED_ORIGIN || "").trim();
  if (!allow) return true; // 未設定＝制限なし（開発初期）
  const origin = request.headers.get("Origin") || "";
  const list = allow.split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(origin);
}

// 添付画像（data:image/ のみ許可・最大10枚）
function asImageList(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((s) => typeof s === "string" && /^data:image\//.test(s)).slice(0, 10);
}

// スケジュール感（マイルストーン）：[{date, text}] を整形。最大20件。
// ※Notionプロパティには入れず、共有HTML／Notion本文にのみ反映する。
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

// Authorization: Bearer <idToken> を取り出す（/form/<id> の認証用）
function bearerToken(request) {
  const h = request.headers.get("Authorization") || request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : "";
}

// ---- 再編集の権限（フェーズ2） --------------------------------
// 許可されるのは「依頼者本人（保存メールと一致）」＋「CREATIVE_EDITOR_EMAILS の許可メール」。
function editorEmailSet(env) {
  return new Set(
    (env.CREATIVE_EDITOR_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}
function canEdit(userEmail, ownerEmail, env) {
  const u = String(userEmail || "").trim().toLowerCase();
  if (!u) return false;
  if (u === String(ownerEmail || "").trim().toLowerCase()) return true; // 依頼者本人
  return editorEmailSet(env).has(u); // クリ室メンバー
}

// 現在時刻を JST（Asia/Tokyo）の "YYYY-MM-DD HH:MM" で返す。
// ※WorkerはUTC稼働。Intlに依存せず +9時間して整形する（環境差で壊れないように）。
function jstStamp(ms) {
  const base = (ms == null || Number.isNaN(ms)) ? Date.now() : ms;
  const d = new Date(base + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
    " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes())
  );
}

// 変更差分の検出（再編集時の「変更した項目」用）。値を文字列化して比較する。
function normVal(v) {
  if (Array.isArray(v)) return JSON.stringify(v.map((x) => (typeof x === "string" ? x : x)));
  return String(v == null ? "" : v).trim();
}
function diffLabels(oldData, newData) {
  const fields = [
    ["title", "案件名"],
    ["category", "依頼カテゴリ"],
    ["brand", "対象ブランド・部署"],
    ["requesterDept", "依頼者部署"],
    ["productTypes", "制作物の種別"],
    ["deadline", "希望納期"],
    ["dataStorage", "データ格納先"],
    ["schedule", "スケジュール感"],
    ["images", "参考画像"],
    ...SEC_YOKEN,
    ...SEC_SEISAKU,
    ...SEC_SOUDAN,
    ...SEC_KAITEI,
  ];
  const out = [];
  const seen = new Set();
  for (const [k, label] of fields) {
    if (seen.has(k)) continue;
    seen.add(k);
    if (normVal(oldData ? oldData[k] : "") !== normVal(newData ? newData[k] : "")) out.push(label);
  }
  return out;
}

// ---- 共有HTMLの生成 --------------------------------------------
// editUrl を渡すと、フッターに「この依頼を編集する」ボタンを表示する（フェーズ2）。
// ボタンはただのリンク。実際の編集可否はフォーム側のログイン＋Worker側の権限判定で担保する。
function buildShareHtml(data, editUrl) {
  const category = data.category || "（種別未設定）";
  const title = data.title || "（無題）";
  const sections = sectionsFor(data.category);
  const productTypes = asProductTypeList(data.productTypes);
  const images = asImageList(data.images);
  const imgHtml = images.length
    ? '<div class="imgs">' + images.map((src) => '<img src="' + src + '" alt="">').join("") + "</div>"
    : "";

  const rows = sections
    .map(([name, label]) => {
      const raw = data[name];
      let body = "";
      if (Array.isArray(raw)) {
        const list = raw.map((x) => String(x).trim()).filter(Boolean);
        if (!list.length) return "";
        body = list
          .map((u) => (/^https?:\/\//i.test(u)
            ? '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(u) + "</a>"
            : esc(u)))
          .join("<br>");
      } else {
        const v = (raw || "").toString().trim();
        if (!v) return "";
        body = /^https?:\/\//i.test(v)
          ? '<a href="' + esc(v) + '" target="_blank" rel="noopener">' + esc(v) + "</a>"
          : esc(v).replace(/\n/g, "<br>");
      }
      return '<div class="row"><div class="label">' + esc(label) + '</div><div class="val">' + body + "</div></div>";
    })
    .join("");

  // スケジュール感（マイルストーン）
  const schedule = asScheduleList(data.schedule);
  const scheduleHtml = schedule.length
    ? '<div class="row"><div class="label">スケジュール感</div><div class="val">' +
      schedule
        .map((m) => (m.date ? "<b>" + esc(m.date) + "</b>　" : "") + esc(m.text))
        .join("<br>") +
      "</div></div>"
    : "";

  const meta = [
    ["依頼カテゴリ", category],
    data.deadline ? ["希望納期", data.deadline] : null,
    data.brand ? ["対象ブランド・部署", data.brand] : null,
    ["依頼者部署", data.requesterDept || "－"],
    productTypes.length ? ["制作物の種別", productTypes.join("、")] : null,
    ["依頼者", (data.requesterName || "") + (data.requesterEmail ? "（" + data.requesterEmail + "）" : "")],
  ]
    .filter(Boolean)
    .map(([k, v]) => '<div class="meta-item"><span>' + esc(k) + "</span><b>" + esc(v) + "</b></div>")
    .join("");

  return (
    '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>" + esc(title) + " ｜ 制作依頼</title><style>" +
    "body{font-family:-apple-system,'Hiragino Kaku Gothic ProN',sans-serif;background:#f5f6f8;color:#1f2430;margin:0;padding:24px;line-height:1.7}" +
    ".wrap{max-width:760px;margin:0 auto;background:#fff;border-radius:14px;box-shadow:0 6px 30px rgba(0,0,0,.06);overflow:hidden}" +
    ".head{padding:28px 32px;border-bottom:1px solid #eceef1}" +
    ".kind{display:inline-block;font-size:12px;font-weight:700;color:#fff;background:#2563eb;padding:3px 12px;border-radius:999px;margin-bottom:10px}" +
    "h1{font-size:22px;margin:0}" +
    ".meta{display:flex;flex-wrap:wrap;gap:18px;padding:18px 32px;background:#fafbfc;border-bottom:1px solid #eceef1}" +
    ".meta-item{font-size:13px}.meta-item span{display:block;color:#8a92a0;margin-bottom:2px}.meta-item b{font-size:14px}" +
    ".body{padding:24px 32px}" +
    ".row{display:flex;gap:16px;padding:14px 0;border-bottom:1px dashed #eceef1}.row:last-child{border-bottom:none}" +
    ".label{flex:0 0 150px;font-weight:700;color:#5b6472;font-size:14px}.val{flex:1;font-size:15px;word-break:break-word}" +
    ".val a{color:#2563eb}" +
    ".imgs{display:flex;flex-wrap:wrap;gap:10px;padding:14px 0}.imgs img{max-width:240px;max-height:240px;border-radius:10px;border:1px solid #eceef1}" +
    ".foot{padding:16px 32px;color:#9aa1ad;font-size:12px;border-top:1px solid #eceef1;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}" +
    ".edit-btn{display:inline-flex;align-items:center;gap:6px;text-decoration:none;background:#f4f4f2;color:#1f2430;border:1px solid #e3e3df;border-radius:9px;padding:9px 15px;font-size:13px;font-weight:600}" +
    ".edit-btn:hover{border-color:#bcbcb6}" +
    "</style></head><body><div class=\"wrap\">" +
    '<div class="head"><span class="kind">' + esc(category) + '</span><h1>' + esc(title) + "</h1></div>" +
    '<div class="meta">' + meta + "</div>" +
    '<div class="body">' + ((rows + scheduleHtml) || '<p style="color:#9aa1ad">記載項目はありません。</p>') + imgHtml + "</div>" +
    '<div class="foot"><span>制作依頼ツール ｜ CRAZY CREATIVE 室</span>' +
    (editUrl ? '<a class="edit-btn" href="' + esc(editUrl) + '">✏️ この依頼を編集する</a>' : "") +
    "</div>" +
    "</div></body></html>"
  );
}

// ---- Notion 登録 ------------------------------------------------
// 最小プロパティ＋共有URL。長文与件はページ本文へ。
// ※プロパティ名は DB「案件管理（テスト）」の確定名に合わせている。名称変更時はここを直す。
// clearAbsent=true（再編集時）は、値が無くなった任意プロパティを明示的に空へ更新する。
// （PATCHは送ったプロパティしか変えないため、これが無いと「消したのに古い値が残る」）
function buildNotionProperties(data, shareUrl, clearAbsent) {
  const props = {
    "案件名": { title: [{ text: { content: (data.title || "（無題）").slice(0, 2000) } }] },
    "依頼カテゴリ": { select: { name: data.category || "相談" } },
  };

  const productTypes = asProductTypeList(data.productTypes);

  if (data.brand) props["対象ブランド・部署"] = { select: { name: data.brand } };
  else if (clearAbsent) props["対象ブランド・部署"] = { select: null };

  if (productTypes.length) props["制作物の種別"] = { multi_select: productTypes.map((n) => ({ name: n })) };
  else if (clearAbsent) props["制作物の種別"] = { multi_select: [] };

  if (data.requesterDept) props["依頼者部署"] = { select: { name: data.requesterDept } };
  else if (clearAbsent) props["依頼者部署"] = { select: null };

  if (data.requesterName) props["依頼者名"] = { rich_text: [{ text: { content: data.requesterName } }] };
  else if (clearAbsent) props["依頼者名"] = { rich_text: [] };

  if (data.requesterEmail) props["依頼者メール"] = { email: data.requesterEmail };
  else if (clearAbsent) props["依頼者メール"] = { email: null };

  if (data.deadline) props["希望納期"] = { date: { start: data.deadline } };
  else if (clearAbsent) props["希望納期"] = { date: null };

  if (data.dataStorage) props["データ格納先"] = { url: data.dataStorage };
  else if (clearAbsent) props["データ格納先"] = { url: null };

  return props;
}

// 長文与件のセクション本文ブロック（見出し＋本文＋スケジュール感）だけを組み立てる。
// 新規作成の本文と、再編集時の「更新版」追記の両方で使い回す。
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

// 新規作成時のページ本文（callout共有URL ＋ 画像枚数 ＋ セクション本文）
function buildNotionBlocks(data, shareUrl) {
  const blocks = [];
  if (shareUrl) {
    blocks.push({
      object: "block",
      type: "callout",
      callout: {
        icon: { emoji: "🔗" },
        rich_text: [
          { type: "text", text: { content: "共有ページ: " } },
          { type: "text", text: { content: shareUrl, link: { url: shareUrl } } },
        ],
      },
    });
  }
  const imgCount = asImageList(data.images).length;
  if (imgCount) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: "添付画像：" + imgCount + "枚（共有ページに表示）" } }] },
    });
  }
  return blocks.concat(buildNotionSectionBlocks(data));
}

// 再編集時にページ本文へ「追記」する更新版ブロック（本文は上書きしない・事故リスク回避）。
// divider → 🔄更新版callout（日時・編集者）→ 変更した項目 → 更新後の全セクション本文。
function buildNotionUpdateBlocks(data, changedLabels, editorName, whenMs) {
  const stamp = jstStamp(whenMs);
  const changedText = (changedLabels && changedLabels.length)
    ? "変更した項目：" + changedLabels.join("、")
    : "変更した項目：本文の変更なし（プロパティのみ／画像のみ 等）";
  const imgCount = asImageList(data.images).length;
  const blocks = [
    { object: "block", type: "divider", divider: {} },
    {
      object: "block",
      type: "callout",
      callout: {
        icon: { emoji: "🔄" },
        rich_text: [
          { type: "text", text: { content: "更新版　" + stamp + "（編集：" + (editorName || "不明") + "）" } },
        ],
      },
    },
    {
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: changedText } }] },
    },
  ];
  if (imgCount) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: "添付画像：" + imgCount + "枚（共有ページに最新版を表示）" } }] },
    });
  }
  return blocks.concat(buildNotionSectionBlocks(data));
}

async function createNotionPage(data, shareUrl, env) {
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
      properties: buildNotionProperties(data, shareUrl),
      children: buildNotionBlocks(data, shareUrl),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error("Notion登録に失敗: " + (body && body.message ? body.message : res.status));
  }
  const pageUrl = body.url || ("https://www.notion.so/" + String(body.id || "").replace(/-/g, ""));
  return { pageId: body.id, notionUrl: pageUrl };
}

// 再編集：既存ページのプロパティを更新（PATCH /v1/pages/<id>）
async function updateNotionPageProps(pageId, data, shareUrl, env) {
  const version = (env.NOTION_VERSION || "2022-06-28").trim();
  const res = await fetch("https://api.notion.com/v1/pages/" + pageId, {
    method: "PATCH",
    headers: {
      Authorization: "Bearer " + env.NOTION_TOKEN,
      "Notion-Version": version,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties: buildNotionProperties(data, shareUrl, true) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Notionプロパティ更新に失敗: " + (body && body.message ? body.message : res.status));
  return { notionUrl: body.url || ("https://www.notion.so/" + String(pageId || "").replace(/-/g, "")) };
}

// 再編集：ページ本文の末尾へブロックを追記（PATCH /v1/blocks/<id>/children）
async function appendNotionBlocks(pageId, blocks, env) {
  if (!blocks || !blocks.length) return;
  const version = (env.NOTION_VERSION || "2022-06-28").trim();
  // Notionは1リクエスト最大100ブロック。念のため100件ずつに分割して追記する。
  for (let i = 0; i < blocks.length; i += 100) {
    const chunk = blocks.slice(i, i + 100);
    const res = await fetch("https://api.notion.com/v1/blocks/" + pageId + "/children", {
      method: "PATCH",
      headers: {
        Authorization: "Bearer " + env.NOTION_TOKEN,
        "Notion-Version": version,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ children: chunk }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("Notion本文の追記に失敗: " + (body && body.message ? body.message : res.status));
  }
}

// ---- Slack 投稿（任意） ----------------------------------------
async function postToSlack(data, shareUrl, notionUrl, env) {
  const hook = (env.SLACK_WEBHOOK_URL || "").trim();
  if (!hook) return { posted: false, reason: "SLACK_WEBHOOK_URL未設定" };
  const productTypes = asProductTypeList(data.productTypes);
  const lines = [
    "*新規の制作依頼*［" + (data.category || "種別未設定") + "］",
    "案件名: " + (data.title || "（無題）"),
    data.deadline ? "希望納期: " + data.deadline : null,
    data.brand ? "対象ブランド/部署: " + data.brand : null,
    data.requesterDept ? "依頼者部署: " + data.requesterDept : null,
    productTypes.length ? "制作物の種別: " + productTypes.join("、") : null,
    data.requesterName ? "依頼者: " + data.requesterName : null,
    asImageList(data.images).length ? "添付画像: " + asImageList(data.images).length + "枚" : null,
    "共有ページ: " + shareUrl,
    notionUrl ? "Notion: " + notionUrl : null,
  ].filter(Boolean);
  const res = await fetch(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: lines.join("\n") }),
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

      // Googleログイン検証（フェーズ1）：操作者（新規＝依頼者本人／編集＝編集者）を特定する
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

      const editId = typeof data.editId === "string" ? data.editId.slice(0, 64) : "";
      delete data.editId;

      // ============ 再編集（editId 付き・フェーズ2） ============
      if (editId) {
        const rec = await loadFormRecord(env, editId);
        if (!rec) {
          return json({ error: "編集対象の依頼が見つかりません（削除済み、またはURLが正しくない可能性があります）" }, 404, request, env);
        }
        if (!canEdit(actor.email, rec.requesterEmail, env)) {
          return json({ error: "この依頼を編集する権限がありません（依頼者本人またはクリ室メンバーのみ編集できます）", code: "AUTH" }, 403, request, env);
        }
        // 依頼者は原本を保持（代理編集でもすり替えない）
        data.requesterName = rec.requesterName || (rec.data && rec.data.requesterName) || "";
        data.requesterEmail = rec.requesterEmail || (rec.data && rec.data.requesterEmail) || "";

        const shareUrl = `${url.origin}/v/${editId}`;
        const editUrl = buildEditUrl(env, editId);

        // ① 共有HTMLを同じIDで上書き（共有URLは不変）
        const shareHtml = buildShareHtml(data, editUrl);
        await env.REQUESTS.put(
          "html:" + editId,
          JSON.stringify({ html: shareHtml, category: data.category, title: data.title, savedAt: Date.now() }),
          { expirationTtl: 60 * 60 * 24 * 365 }
        );

        // ② Notion更新（プロパティPATCH＋本文へ「更新版」を追記。本文は上書きしない）
        const changed = diffLabels(rec.data || {}, data);
        let notionUrl = rec.notionUrl || "";
        if (rec.notionPageId) {
          try {
            const up = await updateNotionPageProps(rec.notionPageId, data, shareUrl, env);
            notionUrl = up.notionUrl || notionUrl;
            const upBlocks = buildNotionUpdateBlocks(data, changed, actor.name, Date.now());
            await appendNotionBlocks(rec.notionPageId, upBlocks, env);
          } catch (e) {
            return json({ error: String(e.message || e), shareUrl }, 502, request, env);
          }
        }

        // ③ form:<id> を更新（履歴を追記・直近50件保持）
        const now = Date.now();
        const history = Array.isArray(rec.history) ? rec.history.slice(-49) : [];
        history.push({ at: now, editorName: actor.name, editorEmail: actor.email, changed });
        await saveFormRecord(env, editId, {
          data,
          notionPageId: rec.notionPageId || "",
          notionUrl,
          requesterEmail: data.requesterEmail,
          requesterName: data.requesterName,
          createdAt: rec.createdAt || now,
          updatedAt: now,
          history,
        });

        const result = {
          ok: true,
          id: editId,
          shareUrl,
          notionUrl,
          edited: true,
          changed,
          slackPosted: false,
          slackNote: "再編集のためSlackは投稿しません（新規のみ投稿）",
        };
        if (idem) {
          await env.REQUESTS.put("idem:" + idem, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 7 });
        }
        return json(result, 200, request, env);
      }

      // ============ 新規作成 ============
      // 名前・メールは検証済みトークンからのみ採用する（手入力廃止・フェーズ1）
      data.requesterName = actor.name;
      data.requesterEmail = actor.email;

      // ① KVへ共有HTMLを保存 → 共有URL確定
      const id = makeId();
      const shareUrl = `${url.origin}/v/${id}`;
      const editUrl = buildEditUrl(env, id);
      const shareHtml = buildShareHtml(data, editUrl);
      await env.REQUESTS.put(
        "html:" + id,
        JSON.stringify({ html: shareHtml, category: data.category, title: data.title, savedAt: Date.now() }),
        { expirationTtl: 60 * 60 * 24 * 365 }
      );

      // ② Notion登録
      let notion;
      try {
        notion = await createNotionPage(data, shareUrl, env);
      } catch (e) {
        return json({ error: String(e.message || e), shareUrl }, 502, request, env);
      }

      // フォームJSONをKVへ保存（再編集の元データ・フェーズ2）
      const nowNew = Date.now();
      await saveFormRecord(env, id, {
        data,
        notionPageId: notion.pageId || "",
        notionUrl: notion.notionUrl || "",
        requesterEmail: data.requesterEmail,
        requesterName: data.requesterName,
        createdAt: nowNew,
        updatedAt: nowNew,
        history: [],
      });

      // ③ Slack投稿（任意・失敗しても致命にしない）
      let slack = { posted: false, reason: "" };
      try {
        slack = await postToSlack(data, shareUrl, notion.notionUrl, env);
      } catch (e) {
        slack = { posted: false, reason: String(e.message || e) };
      }

      const result = {
        ok: true,
        id,
        shareUrl,
        notionUrl: notion.notionUrl,
        slackPosted: slack.posted,
        slackNote: slack.reason,
        edited: false,
      };
      if (idem) {
        await env.REQUESTS.put("idem:" + idem, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 7 });
      }
      return json(result, 200, request, env);
    }

    // ②' 再編集用フォームJSONの取得：GET /form/<id>（要ログイン・権限判定・フェーズ2）
    if (request.method === "GET" && path.startsWith("/form/")) {
      const id = path.slice("/form/".length);
      if (!id) return json({ error: "IDがありません" }, 400, request, env);
      const rec = await loadFormRecord(env, id);
      if (!rec) return json({ error: "依頼が見つかりません", code: "NOTFOUND" }, 404, request, env);
      let actor;
      try {
        actor = await verifyGoogleIdToken(bearerToken(request), env);
      } catch (e) {
        if (e instanceof AuthError) return json({ error: String(e.message || e), code: "AUTH" }, 403, request, env);
        return json({ error: String(e.message || e) }, 500, request, env);
      }
      if (!canEdit(actor.email, rec.requesterEmail, env)) {
        return json({ error: "この依頼を編集する権限がありません（依頼者本人またはクリ室メンバーのみ編集できます）", code: "FORBIDDEN" }, 403, request, env);
      }
      const data = rec.data || {};
      return json({
        ok: true,
        id,
        category: data.category || "",
        data,
        requesterName: rec.requesterName || data.requesterName || "",
        requesterEmail: rec.requesterEmail || data.requesterEmail || "",
        updatedAt: rec.updatedAt || rec.createdAt || 0,
        isOwner: String(actor.email).toLowerCase() === String(rec.requesterEmail || "").toLowerCase(),
      }, 200, request, env);
    }

    // ② 共有ページ表示：GET /v/<id>
    if (request.method === "GET" && path.startsWith("/v/")) {
      const id = path.slice(3);
      const raw = await env.REQUESTS.get("html:" + id);
      if (raw === null) {
        return htmlResponse("この依頼ページは見つかりませんでした（削除済み、またはURLが正しくない可能性があります）。", 404);
      }
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        record = { html: raw };
      }
      return htmlResponse(record.html);
    }

    // 稼働確認
    if (request.method === "GET" && path === "/") {
      return htmlResponse("creative-request Worker は稼働中です。");
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders(request, env) });
  },
};
