// 閲覧側：ロック画面（/s/<id>/）→ パスワード確認 → 閲覧用トークン付きURL（/v/<id>/<token>/…）。
// 閲覧者はログイン不要。Cookie は使わない。
import {isId, validPath, mime} from '../public/js/bundle.js';
import {contentHeaders, notFoundResponse} from './headers.js';
import {hashPassword, jstParts, safeEqual, signViewToken, viewTokenState} from './crypto.js';

export const VIEW = {
  tokenSeconds: 2 * 60 * 60, // 解除してから閲覧できる時間
  maxFailures: 5,            // 連続で間違えられる回数
  lockSeconds: 15 * 60,      // 超えたときのロック時間
};

const now = () => Math.floor(Date.now() / 1000);

const MESSAGES = {
  wrong: 'パスワードが違います。',
  empty: 'パスワードを入力してください。',
  locked: '続けて間違えたため、しばらくロックしています。15分ほどたってから、もう一度お試しください。',
};

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }

// ロック画面。ページ名などの中身は一切出さない。画面自体は sandbox ではなく、厳しめの CSP で守る。
function expiryLabel(epochSeconds) {
  const d = new Date((epochSeconds + 9 * 3600) * 1000); // 日本時間
  const pad = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '年' + (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日 ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

function lockPage(id, code, expiresAt) {
  const message = MESSAGES[code];
  const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow"><title>HELLO PAGES</title>'
    + '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ctext y=%22.9em%22 font-size=%2290%22%3E%F0%9F%93%84%3C/text%3E%3C/svg%3E">'
    + '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Noto+Sans+JP:wght@400;700&display=swap" rel="stylesheet">'
    + '<link rel="stylesheet" href="/app.css"></head><body class="lock-body"><main class="lock">'
    + '<p class="lead">このページはパスワードで保護されています。</p>'
    + '<form method="post" action="/s/' + esc(id) + '/unlock" class="lock-form">'
    + '<label class="fl" for="password">パスワード</label>'
    + '<input class="ctl lock-input" id="password" name="password" type="password" maxlength="32" autocomplete="off" autocapitalize="characters" spellcheck="false" autofocus required>'
    + '<button type="button" class="text-btn" id="toggle-pw" aria-controls="password" aria-pressed="false">パスワードを表示する</button>'
    + (message ? '<p class="error-message" role="alert">' + esc(message) + '</p>' : '')
    + '<button type="submit" class="btn-primary">ページを開く</button></form>'
    + '<p class="note">URLを共有した人から、パスワードを受け取ってください。<br>閲覧できる期限：' + esc(expiryLabel(expiresAt)) + ' まで</p></main><script src="/lock.js"></script></body></html>';
  return new Response(html, {headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; img-src data:; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  }});
}

function redirect(location) {
  return new Response(null, {status: 303, headers: {Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'}});
}

async function livePage(env, id) {
  const row = await env.DB.prepare('SELECT id, password_hash, no_password, status, expires_at, locked_until FROM pages WHERE id = ?1').bind(id).first();
  return row && row.status === 'active' && row.expires_at > now() ? row : null;
}

// GET /s/<id>/ ・ POST /s/<id>/unlock
export async function handleShare(request, env, id, rest) {
  if (!isId(id)) return notFoundResponse();
  const page = await livePage(env, id);
  if (!page) return notFoundResponse();

  if (request.method === 'GET' && (rest === '' || rest === 'index.html')) {
    if (page.no_password) return openPage(env, id, page, now());
    const code = new URL(request.url).searchParams.get('e');
    return lockPage(id, MESSAGES[code] ? code : '', page.expires_at);
  }
  if (request.method !== 'POST' || rest !== 'unlock') return notFoundResponse();
  if (page.no_password) return redirect('/s/' + id + '/');

  const back = code => redirect('/s/' + id + '/?e=' + code);
  const t = now();
  if (page.locked_until > t) return back('locked');
  let password = '';
  try { password = String((await request.formData()).get('password') || ''); } catch { /* 空として扱う */ }
  if (!password.trim()) return back('empty');

  const ok = page.password_hash && safeEqual(await hashPassword(env.PASSWORD_PEPPER, id, password), page.password_hash);
  if (!ok) {
    // 連続失敗を数え、上限に達したらロックして回数を戻す（1つの UPDATE で原子的に行う）
    const row = await env.DB.prepare('UPDATE pages SET locked_until = CASE WHEN failed_count + 1 >= ?2 THEN ?3 ELSE locked_until END, failed_count = CASE WHEN failed_count + 1 >= ?2 THEN 0 ELSE failed_count + 1 END WHERE id = ?1 RETURNING locked_until')
      .bind(id, VIEW.maxFailures, t + VIEW.lockSeconds).first();
    return back(row && row.locked_until > t ? 'locked' : 'wrong');
  }

  await env.DB.prepare('UPDATE pages SET failed_count = 0 WHERE id = ?1').bind(id).run();
  return openPage(env, id, page, t);
}

// 閲覧数を数え、閲覧用トークン付きURLへ送る（パスワード解除後、またはパスワードなしのページの入口）。
async function openPage(env, id, page, t) {
  await env.DB.prepare('INSERT INTO views (day, count) VALUES (?1, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1').bind(jstParts(t).day).run();
  // トークンの失効は「2時間後」か「ページの期限」の早いほう。これで配信のたびにDBを見なくても期限が守られる。
  const token = await signViewToken(env.VIEW_TOKEN_SECRET, id, Math.min(t + VIEW.tokenSeconds, page.expires_at));
  return redirect('/v/' + id + '/' + token + '/index.html');
}

// GET /v/<id>/<token>/<path>
export async function handleView(request, env, id, token, rawPath) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return notFoundResponse();
  if (!isId(id)) return notFoundResponse();
  const state = await viewTokenState(env.VIEW_TOKEN_SECRET, id, token, now());
  if (state === 'invalid') return notFoundResponse();

  let path;
  try { path = decodeURIComponent(rawPath); } catch { return notFoundResponse(); }
  if (path === '' || path.endsWith('/')) path += 'index.html';
  if (!validPath(path)) return notFoundResponse();

  if (state === 'expired') {
    // 閲覧URLはアドレスバーに出るため、ブックマーク・転送されがち。2時間で失効しても、ページ自体が公開中なら
    // 共有URL（ロック画面。パスワードなしならそのまま閲覧）へ戻す。中身は返さないので、守りは弱まらない。
    // 戻すのはページ（HTML）を開いたときだけ。CSS・画像などは従来どおり404。
    if (/\.html?$/i.test(path) && await livePage(env, id)) return redirect('/s/' + id + '/');
    return notFoundResponse();
  }

  const range = request.headers.get('Range');
  const object = await env.BUCKET.get('bundles/' + id + '/' + path, range ? {range: request.headers} : undefined);
  if (!object) return notFoundResponse();

  const headers = contentHeaders(object.httpMetadata?.contentType || mime(path));
  headers.set('Accept-Ranges', 'bytes');
  if (range && object.range && object.range.offset !== undefined) {
    const start = object.range.offset, length = object.range.length ?? object.size - start;
    headers.set('Content-Range', 'bytes ' + start + '-' + (start + length - 1) + '/' + object.size);
    headers.set('Content-Length', String(length));
    return new Response(object.body, {status: 206, headers});
  }
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, {headers});
}
