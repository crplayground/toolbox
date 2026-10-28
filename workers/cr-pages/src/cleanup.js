// 期限切れページの後始末。1時間ごとに Cron Trigger（wrangler.toml）から呼ばれる。
// 閲覧は、期限を過ぎた時点で止まっている（配信側が期限を見ている）。ここは保管庫の掃除とデータの整理だけを行う。

export const CLEANUP = {
  pagesPerRun: 10,        // 1回の実行で片付けるページ数（無料プランの処理回数の上限を超えないため）
  pendingGraceSeconds: 3600, // 公開の途中で止まったページを、残骸とみなすまでの時間
};

// 1ページ分のファイルを R2 から消す。消した件数を返す。
export async function deleteBundleFiles(env, id) {
  const prefix = 'bundles/' + id + '/';
  let count = 0;
  for (;;) {
    const listing = await env.BUCKET.list({prefix, limit: 1000});
    if (!listing.objects.length) break;
    await env.BUCKET.delete(listing.objects.map(o => o.key));
    count += listing.objects.length;
    if (!listing.truncated) break;
  }
  return count;
}

export async function runCleanup(env, now = Math.floor(Date.now() / 1000)) {
  const stats = {expired: 0, discarded: 0, purged: 0};

  // ① 期限が切れた公開ページ、と、公開の途中で止まった残骸のファイルを消す
  const {results} = await env.DB.prepare(
    "SELECT id, status FROM pages WHERE (status = 'active' AND expires_at <= ?1) OR (status = 'pending' AND created_at <= ?2) ORDER BY created_at LIMIT ?3"
  ).bind(now, now - CLEANUP.pendingGraceSeconds, CLEANUP.pagesPerRun).all();
  for (const row of results) {
    await deleteBundleFiles(env, row.id);
    await env.DB.prepare("UPDATE pages SET status = ?2, password_hash = NULL WHERE id = ?1").bind(row.id, row.status === 'active' ? 'expired' : 'deleted').run();
    if (row.status === 'active') stats.expired++; else stats.discarded++;
  }

  // ② 公開者のメールなどの記録を、期限から90日たったら行ごと消す（集計用の記録は別の表に残る）
  const purged = await env.DB.prepare("DELETE FROM pages WHERE purge_at <= ?1 AND status IN ('expired', 'deleted')").bind(now).run();
  stats.purged = purged.meta?.changes ?? purged.changes ?? 0;

  console.log('[cr-pages] cleanup', JSON.stringify(stats));
  return stats;
}
