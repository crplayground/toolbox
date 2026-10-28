// CR PAGES Worker。
// Phase 1：土台のみ（稼働確認・配信の入口・404）。公開・ロック画面・ログインは Phase 2 以降。
import {jsonResponse, notFoundResponse} from './headers.js';

// R2・D1 のバインドが生きているかの確認（デプロイ後の動作確認用。中身は返さない）。
async function health(env) {
  const out = {ok: true, r2: false, d1: false};
  try { await env.BUCKET.head('health-check'); out.r2 = true; } catch { /* 未接続 */ }
  try { await env.DB.prepare('SELECT 1').first(); out.d1 = true; } catch { /* 未接続 */ }
  return jsonResponse(out);
}

export default {
  async fetch(request, env) {
    const {pathname} = new URL(request.url);
    if (pathname === '/api/health' && request.method === 'GET') return health(env);
    if (pathname.startsWith('/api/')) return jsonResponse({error: 'Not found'}, 404);
    // 共有ページの入口（/s/<id>/）と閲覧用（/v/<id>/<token>/…）は Phase 2 で実装する。
    if (pathname.startsWith('/s/') || pathname.startsWith('/v/')) return notFoundResponse();
    return env.ASSETS.fetch(request);
  },
};
