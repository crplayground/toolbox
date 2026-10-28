// 署名・ハッシュまわり。鍵（Worker Secret）は env から受け取り、ここには書かない。
import {normalizePassword} from './password.js';

const enc = new TextEncoder();

export function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacHex(secret, message) {
  if (!secret) throw new Error('サーバー設定が未完了です。');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

// 文字列の比較に要する時間から中身を推測されないよう、長さが同じなら最後まで比較する。
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// パスワードの保存値。ページIDごとに異なる値になり、鍵（PASSWORD_PEPPER）が無いと照合できない。
export function hashPassword(pepper, id, password) {
  return hmacHex(pepper, 'pw:' + id + ':' + normalizePassword(password));
}

// 公開者の匿名ハッシュ（上限の判定・集計用）。Google の内部ID（sub）そのものは保存しない。
export function ownerHash(key, sub) {
  return hmacHex(key, 'user:' + sub);
}

// 閲覧用トークン「<失効時刻>.<署名>」。ページIDと失効時刻に対する署名なので、他のページには使えない。
export async function signViewToken(secret, id, exp) {
  return exp + '.' + await hmacHex(secret, 'view:' + id + ':' + exp);
}

export async function verifyViewToken(secret, id, token, now) {
  const m = /^(\d{1,12})\.([a-f0-9]{64})$/.exec(token || '');
  if (!m || Number(m[1]) <= now) return false;
  return safeEqual(m[2], await hmacHex(secret, 'view:' + id + ':' + m[1]));
}

// 日本時間の日付・月・年（集計用）。
export function jstParts(epochSeconds) {
  const iso = new Date((epochSeconds + 9 * 3600) * 1000).toISOString();
  return {day: iso.slice(0, 10), month: iso.slice(0, 7), year: iso.slice(0, 4)};
}
