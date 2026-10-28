// 公開者が自分のページを管理する API：一覧・削除・パスワード再発行。他人のページには触れない（404）。
import {isId} from '../public/js/bundle.js';
import {HttpError} from './errors.js';
import {requireSameOrigin} from './auth.js';
import {hashPassword} from './crypto.js';
import {generatePassword} from './password.js';
import {jsonResponse} from './headers.js';
import {deleteBundleFiles} from './cleanup.js';

const now = () => Math.floor(Date.now() / 1000);

// 自分の、いま公開中のページ
async function ownPage(env, id, user) {
  if (!isId(id)) throw new HttpError(404, 'Not found');
  const row = await env.DB.prepare("SELECT id, title, expires_at FROM pages WHERE id = ?1 AND owner_hash = ?2 AND status = 'active' AND expires_at > ?3").bind(id, user.ownerHash, now()).first();
  if (!row) throw new HttpError(404, 'Not found');
  return row;
}

// GET /api/pages
export async function listPages(env, user) {
  const {results} = await env.DB.prepare(
    "SELECT id, title, created_at, expires_at, file_count, total_bytes FROM pages WHERE owner_hash = ?1 AND status = 'active' AND expires_at > ?2 ORDER BY created_at DESC LIMIT 50"
  ).bind(user.ownerHash, now()).all();
  return jsonResponse({pages: results.map(r => ({id: r.id, title: r.title, createdAt: r.created_at, expiresAt: r.expires_at, files: r.file_count, bytes: r.total_bytes}))});
}

// DELETE /api/pages/<id> … ファイルを消し、URLをすぐ無効にする
export async function deletePage(request, env, user, id) {
  requireSameOrigin(request);
  await ownPage(env, id, user);
  await deleteBundleFiles(env, id);
  await env.DB.prepare("UPDATE pages SET status = 'deleted', password_hash = NULL WHERE id = ?1").bind(id).run();
  return jsonResponse({ok: true});
}

// POST /api/pages/<id>/password … 新しいパスワードを発行する（古いものは使えなくなり、ロックも解除される）
export async function reissuePassword(request, env, user, id) {
  requireSameOrigin(request);
  await ownPage(env, id, user);
  const password = generatePassword();
  await env.DB.prepare('UPDATE pages SET password_hash = ?2, failed_count = 0, locked_until = 0 WHERE id = ?1')
    .bind(id, await hashPassword(env.PASSWORD_PEPPER, id, password)).run();
  return jsonResponse({password});
}
