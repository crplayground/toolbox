// ============================================================
// Cloudflare Worker（検証用）パスワード対応版
// 役割：修正指示HTMLを「保存」して、URLで「表示」する処理係
//   - POST /save   … HTML（＋任意パスワード）を保存し、IDとURLを返す
//   - GET  /v/<id> … パスワード無し→そのまま表示／有り→入力フォーム表示
//   - POST /v/<id> … 入力フォームの送信先。パスワード照合し、正解なら表示
// ※ 閲覧期限（自動削除）は設定しない
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// 推測されにくい16文字のIDを作る
function makeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// パスワード入力フォームのページ（保護ありのときに表示）
function promptPage(id, error) {
  const err = error ? '<p class="err">パスワードが違います</p>' : "";
  return (
    '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>パスワード保護</title><style>" +
    "body{font-family:-apple-system,sans-serif;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;background:#f1f5f9}" +
    ".box{background:#fff;padding:32px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.08);width:300px;text-align:center}" +
    "h1{font-size:18px;margin:0 0 8px}p{color:#555;font-size:14px;margin:4px 0}" +
    "input{width:100%;padding:10px;font-size:15px;box-sizing:border-box;border:1px solid #ccc;border-radius:8px;margin:12px 0}" +
    "button{width:100%;padding:10px;font-size:15px;border:none;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer}" +
    ".err{color:#dc2626}</style></head><body>" +
    '<form class="box" method="POST" action="/v/' + id + '">' +
    "<h1>パスワードを入力</h1><p>この修正指示は保護されています</p>" +
    '<input type="password" name="password" placeholder="パスワード" autofocus>' +
    err +
    '<button type="submit">表示する</button></form></body></html>'
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // ① 保存：POST /save に { html, password } をJSONで送る（passwordは任意）
    if (request.method === "POST" && path === "/save") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "データの形式が不正です" }, 400);
      }
      const html = body && body.html;
      const password = body && body.password ? String(body.password) : null;
      if (!html || html.length < 10) {
        return json({ error: "HTMLが空です" }, 400);
      }
      // 既存IDが渡されれば同じURLのまま中身を上書き更新。無ければ新規発行。
      const reqId = body && typeof body.id === "string" && /^[a-z0-9]{6,32}$/.test(body.id) ? body.id : null;
      const id = reqId || makeId();
      // 保存から1年で自動削除（KVのTTL）。更新のたびに期限はリセットされる。
      await env.REVISIONS.put(id, JSON.stringify({ html, password }), {
        expirationTtl: 60 * 60 * 24 * 365,
      });
      return json({ id, url: `${url.origin}/v/${id}`, password, updated: !!reqId });
    }

    // ①' 削除：POST /delete に { id } を送ると倉庫から消す
    if (request.method === "POST" && path === "/delete") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "データの形式が不正です" }, 400);
      }
      const delId = body && body.id ? String(body.id) : null;
      if (delId) await env.REVISIONS.delete(delId);
      return json({ ok: true });
    }

    // ② 表示：GET / POST 両対応の /v/<id>
    if (path.startsWith("/v/")) {
      const id = path.slice(3);
      const raw = await env.REVISIONS.get(id);
      if (raw === null) {
        return htmlResponse(
          "この修正指示は見つかりませんでした（削除済みの可能性があります）。",
          404
        );
      }

      // 旧形式（生HTML）も壊れないように吸収
      let record;
      try {
        record = JSON.parse(raw);
        if (typeof record !== "object" || record === null) {
          record = { html: raw, password: null };
        }
      } catch {
        record = { html: raw, password: null };
      }

      // パスワードなし → そのまま表示
      if (!record.password) {
        return htmlResponse(record.html);
      }

      // パスワードあり → POSTで照合、GETは入力フォーム
      if (request.method === "POST") {
        const form = await request.formData();
        const input = form.get("password");
        if (input === record.password) {
          return htmlResponse(record.html);
        }
        return htmlResponse(promptPage(id, true), 401);
      }
      return htmlResponse(promptPage(id, false));
    }

    // ルート：稼働確認用
    if (request.method === "GET" && path === "/") {
      return htmlResponse("修正指示シェア（検証用）が稼働中です。");
    }

    return new Response("Not Found", { status: 404, headers: CORS });
  },
};
