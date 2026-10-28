// CR PAGES Worker。
//   /api/*   公開者向け API（Googleログイン必須）
//   /s/<id>/ 共有URLの入口（パスワードのロック画面）
//   /v/<id>/<token>/… ロック解除後の閲覧（sandbox 付きで配信）
//   それ以外は静的ファイル（画面）
import {jsonResponse, notFoundResponse} from './headers.js';
import {errorResponse, HttpError} from './errors.js';
import {exchangeCode, requireSameOrigin, requireUser} from './auth.js';
import {completeBundle, createBundle, putFile} from './api.js';
import {handleShare, handleView} from './view.js';

// R2・D1 のバインドが生きているかの確認（デプロイ後の動作確認用。中身は返さない）。
async function health(env) {
  const out = {ok: true, r2: false, d1: false};
  try { await env.BUCKET.head('health-check'); out.r2 = true; } catch { /* 未接続 */ }
  try { await env.DB.prepare('SELECT 1').first(); out.d1 = true; } catch { /* 未接続 */ }
  return jsonResponse(out);
}

async function api(request, env, pathname) {
  const method = request.method;
  if (pathname === '/api/health' && method === 'GET') return health(env);
  // 画面が使うGoogleクライアントID（公開してよい値）
  if (pathname === '/api/config' && method === 'GET') return jsonResponse({clientId: env.GOOGLE_CLIENT_ID || ''});
  if (pathname === '/api/auth/exchange' && method === 'POST') {
    requireSameOrigin(request);
    let body = {};
    try { body = await request.json(); } catch { /* 下で失敗扱い */ }
    return jsonResponse(await exchangeCode(body.code, request, env));
  }
  if (pathname === '/api/me' && method === 'GET') {
    const user = await requireUser(request, env);
    return jsonResponse({name: user.name, email: user.email, exp: user.exp});
  }
  if (pathname === '/api/bundles' && method === 'POST') return createBundle(request, env, await requireUser(request, env));
  const m = /^\/api\/bundles\/([^/]+)\/(file|complete)$/.exec(pathname);
  if (m && ((m[2] === 'file' && method === 'PUT') || (m[2] === 'complete' && method === 'POST'))) {
    const user = await requireUser(request, env);
    return m[2] === 'file' ? putFile(request, env, user, m[1]) : completeBundle(request, env, user, m[1]);
  }
  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env) {
    const {pathname} = new URL(request.url);
    try {
      if (pathname.startsWith('/api/')) return await api(request, env, pathname);
      let m = /^\/s\/([^/]+)(?:\/(.*))?$/.exec(pathname);
      if (m) {
        if (m[2] === undefined) return new Response(null, {status: 301, headers: {Location: '/s/' + m[1] + '/'}});
        return await handleShare(request, env, m[1], m[2]);
      }
      m = /^\/v\/([^/]+)\/([^/]+)\/(.*)$/.exec(pathname);
      if (m) return await handleView(request, env, m[1], m[2], m[3]);
      if (pathname.startsWith('/s/') || pathname.startsWith('/v/')) return notFoundResponse();
      return env.ASSETS.fetch(request);
    } catch (e) {
      return errorResponse(e);
    }
  },
};
