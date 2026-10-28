// 公開の3段階：①マニフェスト作成 → ②ファイルを1つずつ送信 → ③完了確認（ここでパスワードを発行）。
import {MAX_FILE, isId, isExpiryHours, mime, summarize, validateEntries, validPath} from '../public/js/bundle.js';
import {HttpError} from './errors.js';
import {jstParts, hashPassword} from './crypto.js';
import {generatePassword} from './password.js';
import {jsonResponse} from './headers.js';
import {requireSameOrigin} from './auth.js';

export const LIMITS = {
  activePerUser: 20,          // 1人あたり、同時に有効なページ数
  perUserPerHour: 10,         // 1人あたり、1時間の公開回数
  capacityBytes: 9 * 1024 * 1024 * 1024, // 全体の保存容量。R2の無料枠（10GB）を超えないための上限
  purgeDays: 90,              // 公開者のメールを消すまでの日数（期限から）
};

const now = () => Math.floor(Date.now() / 1000);

async function readBody(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  let total = 0;
  const chunks = [];
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); throw new HttpError(413, 'ファイルサイズが上限を超えています。'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  return bytes;
}

// 自分が作成中（pending）のページだけ取り出す。他人のページや存在しないIDは同じ404にする。
async function pendingPage(env, id, user) {
  if (!isId(id)) throw new HttpError(404, 'Not found');
  const row = await env.DB.prepare("SELECT * FROM pages WHERE id = ?1 AND owner_hash = ?2 AND status = 'pending'").bind(id, user.ownerHash).first();
  if (!row) throw new HttpError(404, 'Not found');
  return row;
}

// ① POST /api/bundles
export async function createBundle(request, env, user) {
  requireSameOrigin(request);
  let body;
  try { body = await request.json(); } catch { throw new HttpError(400, '送信内容が正しくありません。'); }
  const files = (() => { try { return validateEntries(body && body.files); } catch (e) { throw new HttpError(400, e.message); } })();
  if (!isExpiryHours(body.expiryHours)) throw new HttpError(400, '期限を選んでください。');
  const title = String(body.title || '').trim().slice(0, 60) || '無題';

  const t = now();
  const active = await env.DB.prepare("SELECT COUNT(*) AS c FROM pages WHERE owner_hash = ?1 AND status IN ('pending','active') AND expires_at > ?2").bind(user.ownerHash, t).first();
  if (active.c >= LIMITS.activePerUser) throw new HttpError(429, '同時に公開できるのは' + LIMITS.activePerUser + '件までです。不要なページを削除するか、期限が切れるのを待ってください。');
  const recent = await env.DB.prepare('SELECT COUNT(*) AS c FROM pages WHERE owner_hash = ?1 AND created_at > ?2').bind(user.ownerHash, t - 3600).first();
  if (recent.c >= LIMITS.perUserPerHour) throw new HttpError(429, '公開は1時間に' + LIMITS.perUserPerHour + '回までです。しばらくしてからお試しください。');

  const total = files.reduce((n, f) => n + f.size, 0);
  const used = await env.DB.prepare("SELECT COALESCE(SUM(total_bytes), 0) AS s FROM pages WHERE status IN ('pending','active') AND expires_at > ?1").bind(t).first();
  if (used.s + total > LIMITS.capacityBytes) throw new HttpError(507, '保存容量の上限に達しています。管理者に連絡してください。');

  const id = crypto.randomUUID();
  const expires = t + body.expiryHours * 3600; // 仮の期限。③の完了時に確定する
  await env.DB.prepare('INSERT INTO pages (id, title, status, owner_hash, owner_email, files_json, file_count, total_bytes, created_at, expires_at, purge_at) VALUES (?1, ?2, \'pending\', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)')
    .bind(id, title, user.ownerHash, user.email, JSON.stringify(files), files.length, total, t, expires, expires + LIMITS.purgeDays * 86400).run();
  return jsonResponse({id});
}

// ② PUT /api/bundles/<id>/file?path=…
export async function putFile(request, env, user, id) {
  requireSameOrigin(request);
  const page = await pendingPage(env, id, user);
  const path = new URL(request.url).searchParams.get('path');
  const entry = validPath(path) && JSON.parse(page.files_json).find(f => f.path === path);
  if (!entry) throw new HttpError(400, '無効なファイルです。');
  const declared = Number(request.headers.get('Content-Length'));
  if (declared > MAX_FILE) throw new HttpError(413, 'ファイルサイズが上限を超えています。');
  const bytes = await readBody(request, entry.size);
  if (bytes.byteLength !== entry.size) throw new HttpError(400, 'ファイルサイズが申告と一致しません。もう一度お試しください。');
  await env.BUCKET.put('bundles/' + id + '/' + path, bytes, {httpMetadata: {contentType: mime(path)}});
  return jsonResponse({ok: true});
}

// ③ POST /api/bundles/<id>/complete
export async function completeBundle(request, env, user, id) {
  requireSameOrigin(request);
  const page = await pendingPage(env, id, user);
  const files = JSON.parse(page.files_json);

  const stored = new Map();
  let cursor;
  do {
    const listing = await env.BUCKET.list({prefix: 'bundles/' + id + '/', cursor, limit: 1000});
    for (const o of listing.objects) stored.set(o.key.slice(('bundles/' + id + '/').length), o.size);
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  const missing = files.filter(f => stored.get(f.path) !== f.size).map(f => f.path);
  if (missing.length) throw new HttpError(400, 'アップロードが完了していないファイルがあります（' + missing.slice(0, 3).join('、') + '）。もう一度お試しください。');

  const t = now();
  const hours = Math.round((page.expires_at - page.created_at) / 3600);
  const expires = t + hours * 3600;
  const password = generatePassword();
  const s = summarize(files);
  const jst = jstParts(t);
  await env.DB.batch([
    env.DB.prepare("UPDATE pages SET status = 'active', password_hash = ?2, expires_at = ?3, purge_at = ?4 WHERE id = ?1 AND status = 'pending'")
      .bind(id, await hashPassword(env.PASSWORD_PEPPER, id, password), expires, expires + LIMITS.purgeDays * 86400),
    env.DB.prepare('INSERT INTO events (ts, month, year, user_hash, file_count, total_bytes, html_bytes, css_bytes, js_bytes, other_bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)')
      .bind(t, jst.month, jst.year, user.ownerHash, s.files, s.bytes, s.html, s.css, s.js, s.other),
  ]);
  // パスワードはここで一度だけ返す（サーバーには鍵付きハッシュしか残らない）
  return jsonResponse({id, title: page.title, url: new URL(request.url).origin + '/s/' + id + '/', password, expiresAt: expires});
}
