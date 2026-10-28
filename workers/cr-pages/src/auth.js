// Googleログインの検証。Creative Process と同じ方式（One Tap のIDトークン、または認可コード→IDトークンの交換）。
// どちらの経路でも、最終的にここでIDトークンの署名とクレームを必ず検証する。画面の表示だけでは認可しない。
import {HttpError} from './errors.js';
import {ownerHash} from './crypto.js';

export const HOSTED_DOMAIN = 'crazy.co.jp';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

let cached; // {keys, expires}

function decode(segment) {
  const base = segment.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base.padEnd(Math.ceil(base.length / 4) * 4, '='));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function keys(force = false) {
  if (!force && cached && cached.expires > Date.now()) return cached.keys;
  const response = await fetch(JWKS_URL);
  if (!response.ok) throw new Error('Googleの公開鍵を取得できませんでした。');
  const data = await response.json();
  const maxAge = Number(response.headers.get('Cache-Control')?.match(/max-age=(\d+)/)?.[1] || 3600);
  cached = {keys: data.keys, expires: Date.now() + Math.min(maxAge, 3600) * 1000};
  return data.keys;
}

export function resetKeyCache() { cached = undefined; }

const BAD = 'ログイン情報が不正です。もう一度ログインしてください。';

export async function verifyGoogleToken(token, env, now = Math.floor(Date.now() / 1000)) {
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(500, 'サーバー設定が未完了です。');
  if (!token || token.length > 10000) throw new HttpError(401, 'Googleでログインしてください。');
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, BAD);
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
  } catch { throw new HttpError(401, BAD); }
  if (header.alg !== 'RS256' || !header.kid) throw new HttpError(401, BAD);

  let jwk;
  try {
    jwk = (await keys()).find(k => k.kid === header.kid) || (await keys(true)).find(k => k.kid === header.kid);
  } catch { throw new HttpError(503, 'Googleのログイン確認に失敗しました。時間をおいて、もう一度お試しください。'); }
  if (!jwk) throw new HttpError(401, BAD);
  const key = await crypto.subtle.importKey('jwk', jwk, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!valid) throw new HttpError(401, BAD);

  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss || '') || claims.aud !== env.GOOGLE_CLIENT_ID || !claims.sub) throw new HttpError(401, BAD);
  if (!claims.exp || claims.exp <= now) throw new HttpError(401, 'ログインの有効期限が切れました。もう一度ログインしてください。');
  if (claims.email_verified !== true || claims.hd !== HOSTED_DOMAIN || !/@crazy\.co\.jp$/i.test(claims.email || '')) {
    throw new HttpError(403, '@crazy.co.jp のGoogleアカウントでログインしてください。');
  }
  return {sub: claims.sub, email: claims.email, name: claims.name || claims.email, exp: claims.exp};
}

// API 呼び出しの本人確認。Authorization: Bearer <IDトークン>
export async function requireUser(request, env) {
  const match = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9._-]+)$/);
  if (!match) throw new HttpError(401, 'Googleでログインしてください。');
  const user = await verifyGoogleToken(match[1], env);
  return {...user, ownerHash: await ownerHash(env.USER_HASH_KEY, user.sub)};
}

// 状態を変える要求は、このサイト自身の画面からのものだけ受け付ける。
export function requireSameOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw new HttpError(403, '無効な送信元です。');
}

// ポップアップ方式の認可コード → IDトークン。redirect_uri は呼び出し元ページのオリジン（Creative Process と同じ）。
export async function exchangeCode(code, request, env) {
  requireSameOrigin(request);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new HttpError(500, 'サーバー設定が未完了です。');
  if (typeof code !== 'string' || !code || code.length > 2000) throw new HttpError(400, 'ログインに失敗しました。もう一度お試しください。');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: new URL(request.url).origin,
      grant_type: 'authorization_code',
    }),
  });
  let data = {};
  try { data = await response.json(); } catch { /* 下で失敗扱い */ }
  if (!response.ok || !data.id_token) {
    // Google のエラーコードだけをログに残す（ブラウザには返さない）。`npx wrangler tail` で見られる。
    console.error('[cr-pages] コード交換に失敗:', data.error || response.status);
    throw new HttpError(400, 'ログインに失敗しました。もう一度お試しください。');
  }
  const user = await verifyGoogleToken(data.id_token, env);
  return {idToken: data.id_token, name: user.name, email: user.email, exp: user.exp};
}
