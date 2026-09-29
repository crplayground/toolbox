// Project Management Board: Compass（compass）Worker
//
// GET  /data                      … 全データを返す { version, updatedAt, data }
// PUT  /data                      … 全データを保存。body { baseVersion, data }。baseVersion が最新と違えば 409（別端末の更新を上書きしない）
// GET  /backups                   … バックアップの日付一覧
// GET  /backups/YYYY-MM-DD        … その日のバックアップ
// GET  /notion/pages/:id          … 依頼ページの読み取り（Notion API をそのまま中継。GETのみ）
// GET  /notion/blocks/:id/children
// POST /plan                      … 依頼ページを全文読み、AI（Gemini）でWBSの提案を作る（src/plan.js）
// GET  /learning                  … 作業スタイルの学習レポート（src/learning.js）。LEARN_TOKEN でも読める
//
// すべて Authorization: Bearer <APP_TOKEN> が必要（/learning だけは LEARN_TOKEN も可）。

import { handlePlan } from "./plan.js";
import { handleLearning } from "./learning.js";

const DATA_KEY = "data";
const BACKUP_TTL = 60 * 60 * 24 * 30;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

    if (!env.APP_TOKEN) return json({ error: "サーバー設定が未完了です（APP_TOKEN）" }, 500);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    const auth = request.headers.get("Authorization") || "";

    // 学習レポートは、Claudeの定期タスク用の読み取り専用トークン（LEARN_TOKEN）でも読める。
    // APP_TOKEN（全データの書き換えができる）をパソコン上のファイルに置かないため
    if (path === "/learning" && request.method === "GET" && env.LEARN_TOKEN && (await safeEqual(auth, `Bearer ${env.LEARN_TOKEN}`))) {
      try {
        return await handleLearning(url, env, json);
      } catch (e) {
        return json({ error: `サーバーエラー：${e.message}` }, 500);
      }
    }
    if (!(await safeEqual(auth, `Bearer ${env.APP_TOKEN}`))) return json({ error: "合言葉が違います" }, 401);

    try {
      if (path === "/data" && request.method === "GET") {
        const stored = await env.DATA.get(DATA_KEY, "json");
        return json(stored || { version: 0, updatedAt: null, data: null });
      }

      if (path === "/data" && request.method === "PUT") {
        const body = await request.json().catch(() => null);
        if (!body || typeof body.data !== "object" || body.data === null) return json({ error: "データの形式が不正です" }, 400);
        const current = (await env.DATA.get(DATA_KEY, "json")) || { version: 0 };
        if (body.baseVersion !== current.version) {
          return json({ error: "別の端末で更新されています", current }, 409);
        }
        const next = { version: current.version + 1, updatedAt: new Date().toISOString(), data: body.data };
        await env.DATA.put(DATA_KEY, JSON.stringify(next));
        // その日の最初の保存時だけバックアップを取る（KVの書き込み回数を抑える）
        const day = next.updatedAt.slice(0, 10);
        if (current.version > 0 && !(await env.DATA.get(`backup:${day}`, "text"))) {
          await env.DATA.put(`backup:${day}`, JSON.stringify(current), { expirationTtl: BACKUP_TTL });
        }
        return json({ version: next.version, updatedAt: next.updatedAt });
      }

      if (path === "/backups" && request.method === "GET") {
        const list = await env.DATA.list({ prefix: "backup:" });
        return json({ days: list.keys.map((k) => k.name.slice(7)).sort().reverse() });
      }

      const backup = path.match(/^\/backups\/(\d{4}-\d{2}-\d{2})$/);
      if (backup && request.method === "GET") {
        const stored = await env.DATA.get(`backup:${backup[1]}`, "json");
        return stored ? json(stored) : json({ error: "バックアップがありません" }, 404);
      }

      const notion = path.match(/^\/notion\/(pages\/[0-9a-f]{32}|blocks\/[0-9a-f]{32}\/children)$/);
      if (notion && request.method === "GET") {
        if (!env.NOTION_TOKEN) return json({ error: "依頼ページの読み込みは未設定です（NOTION_TOKEN）" }, 501);
        const res = await fetch(`https://api.notion.com/v1/${notion[1]}${url.search}`, {
          headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": env.NOTION_VERSION || "2022-06-28" },
        });
        const text = await res.text();
        return new Response(text, { status: res.status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
      }

      if (path === "/plan" && request.method === "POST") return await handlePlan(request, env, json);
      if (path === "/learning" && request.method === "GET") return await handleLearning(url, env, json);

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: `サーバーエラー：${e.message}` }, 500);
    }
  },
};

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "",
    "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** 長さと内容を一定時間で比較（合言葉の総当たり対策の基本） */
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
