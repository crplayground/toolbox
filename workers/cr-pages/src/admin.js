// 管理者ボード用の集計。見られるのは ADMIN_EMAILS（Worker Secret）に載っている人だけ。
// 返すのは集計値だけ。個人名・メールアドレス・「誰がいくつ公開したか」は含めない。
import {HttpError} from './errors.js';
import {jsonResponse} from './headers.js';
import {jstParts} from './crypto.js';
import {LIMITS} from './api.js';

export function isAdmin(env, user) {
  const admins = String(env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return admins.includes(String(user.email || '').toLowerCase());
}

// 直近 n か月の 'YYYY-MM'（日本時間、古い順）
export function lastMonths(now, n) {
  const d = new Date((now + 9 * 3600) * 1000);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(y + '-' + String(m + 1).padStart(2, '0'));
    if (--m < 0) { m = 11; y--; }
  }
  return out.reverse();
}

const COLUMNS = 'COUNT(*) AS pages, COUNT(DISTINCT user_hash) AS users, SUM(file_count) AS files, SUM(total_bytes) AS bytes, SUM(html_bytes) AS html, SUM(css_bytes) AS css, SUM(js_bytes) AS js, SUM(other_bytes) AS other';

function row(key, e, views) {
  return {key, pages: e?.pages ?? 0, views: views ?? 0, users: e?.users ?? 0, files: e?.files ?? 0, bytes: e?.bytes ?? 0, html: e?.html ?? 0, css: e?.css ?? 0, js: e?.js ?? 0, other: e?.other ?? 0};
}

// GET /api/admin/stats
export async function adminStats(env, user, now = Math.floor(Date.now() / 1000)) {
  if (!isAdmin(env, user)) throw new HttpError(404, 'Not found'); // 管理機能があることも示さない

  const byMonth = new Map((await env.DB.prepare('SELECT month AS k, ' + COLUMNS + ' FROM events GROUP BY month').all()).results.map(r => [r.k, r]));
  const byYear = new Map((await env.DB.prepare('SELECT year AS k, ' + COLUMNS + ' FROM events GROUP BY year').all()).results.map(r => [r.k, r]));
  const viewsByMonth = new Map((await env.DB.prepare('SELECT substr(day, 1, 7) AS k, SUM(count) AS v FROM views GROUP BY k').all()).results.map(r => [r.k, r.v]));
  const viewsByYear = new Map((await env.DB.prepare('SELECT substr(day, 1, 4) AS k, SUM(count) AS v FROM views GROUP BY k').all()).results.map(r => [r.k, r.v]));
  const total = await env.DB.prepare('SELECT ' + COLUMNS + ' FROM events').first();
  const totalViews = await env.DB.prepare('SELECT COALESCE(SUM(count), 0) AS v FROM views').first();
  const active = await env.DB.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(total_bytes), 0) AS s FROM pages WHERE status = 'active' AND expires_at > ?1").bind(now).first();

  const thisYear = Number(jstParts(now).year);
  const years = new Set([String(thisYear), ...byYear.keys(), ...viewsByYear.keys()]);

  return jsonResponse({
    generatedAt: now,
    current: {activePages: active.c, bytes: active.s, capacityBytes: LIMITS.capacityBytes},
    totals: row('all', total, totalViews.v),
    months: lastMonths(now, 12).map(k => row(k, byMonth.get(k), viewsByMonth.get(k))),
    years: [...years].sort().map(k => row(k, byYear.get(k), viewsByYear.get(k))),
  });
}
