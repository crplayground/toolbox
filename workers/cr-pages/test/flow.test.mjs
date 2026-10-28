// CR PAGES 通しテスト：ログイン検証 → 公開 → ロック画面 → 閲覧 → 上限・期限。
// 本物のD1・R2・Googleの代わりに、メモリ上の代用品（node:sqlite・Map・自前のJWT）で動かす。
// 実行：cd workers/cr-pages && node test/flow.test.mjs
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/worker.js';
import {resetKeyCache} from '../src/auth.js';
import {signViewToken} from '../src/crypto.js';
import {LIMITS} from '../src/api.js';
import {VIEW} from '../src/view.js';

let failed = 0;
function t(name, ok, detail) { if (!ok) { failed++; console.log('NG  ' + name + (detail ? '  → ' + detail : '')); } else console.log('ok  ' + name); }

// ── 代用品 ──
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
const wrap = (sql, params = []) => ({
  _sql: sql, _params: params,
  bind: (...p) => wrap(sql, p.map(v => v === undefined ? null : v)),
  first: async () => db.prepare(sql).get(...params) ?? null,
  run: async () => { db.prepare(sql).run(...params); return {success: true}; },
});
const DB = {
  prepare: sql => wrap(sql),
  batch: async stmts => { db.exec('BEGIN'); try { for (const s of stmts) db.prepare(s._sql).run(...s._params); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return []; },
};
const store = new Map();
const BUCKET = {
  head: async key => store.has(key) ? {size: store.get(key).bytes.byteLength} : null,
  put: async (key, bytes, opts) => { store.set(key, {bytes: new Uint8Array(bytes), contentType: opts?.httpMetadata?.contentType}); },
  list: async ({prefix}) => ({objects: [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({key, size: v.bytes.byteLength})), truncated: false}),
  get: async (key, opts) => {
    const v = store.get(key);
    if (!v) return null;
    const base = {size: v.bytes.byteLength, httpMetadata: {contentType: v.contentType}};
    const m = opts?.range && /^bytes=(\d+)-(\d*)$/.exec(opts.range.get('Range'));
    if (m) {
      const offset = Number(m[1]), end = m[2] ? Number(m[2]) : v.bytes.byteLength - 1;
      return {...base, range: {offset, length: end - offset + 1}, body: new Response(v.bytes.slice(offset, end + 1)).body};
    }
    return {...base, body: new Response(v.bytes).body};
  },
};
const env = {
  DB, BUCKET, ASSETS: {fetch: async () => new Response('asset')},
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret',
  VIEW_TOKEN_SECRET: 'view-secret-for-test', PASSWORD_PEPPER: 'pepper-for-test', USER_HASH_KEY: 'user-hash-key-for-test',
};

// ── 偽のGoogle ──
const pair = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
const jwk = {...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'test-kid', alg: 'RS256', use: 'sig'};
const b64 = buf => Buffer.from(buf).toString('base64url');
async function makeToken(claims = {}, {alg = 'RS256', key = pair.privateKey} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({alg, kid: 'test-kid', typ: 'JWT'}));
  const payload = b64(JSON.stringify({iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID, sub: 'sub-alice', email: 'alice@crazy.co.jp', email_verified: true, hd: 'crazy.co.jp', name: 'Alice', exp: now + 3600, ...claims}));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(header + '.' + payload));
  return header + '.' + payload + '.' + b64(sig);
}
let tokenCall = null;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/oauth2/v3/certs')) return new Response(JSON.stringify({keys: [jwk]}), {headers: {'Cache-Control': 'max-age=3600'}});
  if (String(url) === 'https://oauth2.googleapis.com/token') {
    tokenCall = Object.fromEntries(new URLSearchParams(init.body));
    return tokenCall.code === 'good' ? new Response(JSON.stringify({id_token: await makeToken()})) : new Response(JSON.stringify({error: 'invalid_grant'}), {status: 400});
  }
  throw new Error('想定外の通信: ' + url);
};

const ORIGIN = 'https://pages.test';
const call = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
const authed = async (claims, extra = {}) => ({Authorization: 'Bearer ' + await makeToken(claims), Origin: ORIGIN, ...extra});
const alice = await authed();
const bob = await authed({sub: 'sub-bob', email: 'bob@crazy.co.jp', name: 'Bob'});

// ── 設定 ──
t('クライアントIDを画面に渡す', (await (await call('/api/config')).json()).clientId === env.GOOGLE_CLIENT_ID);

// ── ログイン検証 ──
const me = async headers => call('/api/me', {headers});
t('正しいIDトークンで本人確認できる', (await me(alice)).status === 200);
t('トークンなしは401', (await me({})).status === 401);
t('別クライアント宛て(aud違い)は拒否', (await me(await authed({aud: 'other'}))).status === 401);
t('期限切れは拒否', (await me(await authed({exp: Math.floor(Date.now() / 1000) - 10}))).status === 401);
t('crazy.co.jp 以外のドメイン(hd違い)は403', (await me(await authed({hd: 'example.com', email: 'x@example.com'}))).status === 403);
t('hd がない個人Gmailは403', (await me(await authed({hd: undefined, email: 'x@gmail.com'}))).status === 403);
t('メール未確認は403', (await me(await authed({email_verified: false}))).status === 403);
t('発行元(iss)違いは拒否', (await me(await authed({iss: 'https://evil.example'}))).status === 401);
const other = (await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify'])).privateKey;
t('別の鍵で署名したトークンは拒否', (await me(await authed({}, {Authorization: 'Bearer ' + await makeToken({}, {key: other})}))).status === 401);
const tampered = (await makeToken()).split('.');
tampered[1] = b64(JSON.stringify({...JSON.parse(Buffer.from(tampered[1], 'base64url')), email: 'ceo@crazy.co.jp'}));
t('中身を書き換えたトークンは拒否', (await me({Authorization: 'Bearer ' + tampered.join('.'), Origin: ORIGIN})).status === 401);
t('alg が RS256 以外は拒否', (await me({Authorization: 'Bearer ' + await makeToken({}, {alg: 'none'}), Origin: ORIGIN})).status === 401);

// ── 認可コードの交換 ──
const ex = (code, origin = ORIGIN) => call('/api/auth/exchange', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: origin}, body: JSON.stringify({code})});
const exOk = await ex('good');
const exBody = await exOk.json();
t('認可コードからIDトークンを得て、検証して返す', exOk.status === 200 && exBody.email === 'alice@crazy.co.jp' && !!exBody.idToken);
t('交換時の redirect_uri は呼び出し元のオリジン', tokenCall.redirect_uri === ORIGIN && tokenCall.client_secret === 'test-secret' && tokenCall.grant_type === 'authorization_code');
const exBad = await ex('bad');
t('Googleが拒否したら400（詳細はブラウザに返さない）', exBad.status === 400 && !JSON.stringify(await exBad.json()).includes('invalid_grant'));
t('別のオリジンからの交換は403', (await ex('good', 'https://evil.example')).status === 403);

// ── 公開 ──
const json = (headers, body) => ({method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body)});
const files = [
  {path: 'index.html', body: '<!doctype html><title>資料</title><link rel="stylesheet" href="css/a.css"><p>hello</p>', type: 'text/html'},
  {path: 'css/a.css', body: 'p{color:red}', type: 'text/css'},
];
const manifest = {title: '資料', expiryHours: 168, files: files.map(f => ({path: f.path, size: new TextEncoder().encode(f.body).length}))};
async function publish(headers = alice, m = manifest) {
  const create = await call('/api/bundles', json(headers, m));
  if (create.status !== 200) return {create};
  const {id} = await create.json();
  for (const f of files) await call('/api/bundles/' + id + '/file?path=' + encodeURIComponent(f.path), {method: 'PUT', headers: {...headers, 'Content-Type': 'application/octet-stream'}, body: f.body});
  const complete = await call('/api/bundles/' + id + '/complete', {method: 'POST', headers});
  return {id, complete, result: complete.status === 200 ? await complete.json() : null};
}

t('ログインなしでは公開できない', (await call('/api/bundles', json({Origin: ORIGIN}, manifest))).status === 401);
t('別オリジンからは公開できない', (await call('/api/bundles', json({...alice, Origin: 'https://evil.example'}, manifest))).status === 403);
t('選択肢にない期限は400', (await call('/api/bundles', json(alice, {...manifest, expiryHours: 48}))).status === 400);
t('index.html がない一式は400', (await call('/api/bundles', json(alice, {...manifest, files: [{path: 'a.html', size: 5}]}))).status === 400);

const p1 = await publish();
t('公開できる', p1.complete.status === 200 && p1.result.url === ORIGIN + '/s/' + p1.id + '/');
t('パスワードは8文字で、期限は約7日後', /^[2-9A-HJ-NP-Z]{8}$/.test(p1.result.password) && Math.abs(p1.result.expiresAt - (Date.now() / 1000 + 168 * 3600)) < 60);
const row = db.prepare('SELECT * FROM pages WHERE id = ?').get(p1.id);
t('DBにパスワードの平文を保存しない（鍵付きハッシュのみ）', row.password_hash.length === 64 && !JSON.stringify(row).includes(p1.result.password));
t('公開者のGoogle内部IDは保存せず、匿名ハッシュのみ', row.owner_hash.length === 64 && !JSON.stringify(row).includes('sub-alice'));
t('追跡用に公開者メールを保存', row.owner_email === 'alice@crazy.co.jp' && row.purge_at - row.expires_at === 90 * 86400);
const ev = db.prepare('SELECT * FROM events').all();
t('集計用の記録が1件（種別ごとの容量つき）', ev.length === 1 && ev[0].file_count === 2 && ev[0].html_bytes === manifest.files[0].size && ev[0].css_bytes === manifest.files[1].size && ev[0].user_hash === row.owner_hash);

// 公開途中の失敗
const c2 = await (await call('/api/bundles', json(alice, manifest))).json();
t('全ファイルを送る前の完了は400', (await call('/api/bundles/' + c2.id + '/complete', {method: 'POST', headers: alice})).status === 400);
t('申告と違うサイズは400', (await call('/api/bundles/' + c2.id + '/file?path=index.html', {method: 'PUT', headers: alice, body: 'x'})).status === 400);
t('マニフェストにないパスは400', (await call('/api/bundles/' + c2.id + '/file?path=evil.js', {method: 'PUT', headers: alice, body: 'x'})).status === 400);
t('他人のページには送れない（404）', (await call('/api/bundles/' + c2.id + '/file?path=index.html', {method: 'PUT', headers: bob, body: files[0].body})).status === 404);
t('他人のページの完了もできない（404）', (await call('/api/bundles/' + c2.id + '/complete', {method: 'POST', headers: bob})).status === 404);
t('公開済みのページには送れない', (await call('/api/bundles/' + p1.id + '/file?path=index.html', {method: 'PUT', headers: alice, body: files[0].body})).status === 404);

// ── ロック画面 ──
const lock = await call('/s/' + p1.id + '/');
const lockHtml = await lock.text();
t('ロック画面が出る（ページ名は出さない）', lock.status === 200 && lockHtml.includes('パスワード') && !lockHtml.includes('資料'));
t('ロック画面は sandbox ではなく厳しいCSP', !/sandbox/.test(lock.headers.get('Content-Security-Policy')) && /form-action 'self'/.test(lock.headers.get('Content-Security-Policy')) && lock.headers.get('Cache-Control') === 'no-store');
t('/s/<id> は末尾スラッシュへ', (await call('/s/' + p1.id)).status === 301);
t('/s/<id>/index.html でもロック画面（旧URL形式）', (await call('/s/' + p1.id + '/index.html')).status === 200);
t('存在しないID・不正なIDは同じ404', (await call('/s/00000000-0000-4000-8000-000000000000/')).status === 404 && (await call('/s/abc/')).status === 404);

const unlock = (id, password) => call('/s/' + id + '/unlock', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({password})});
const r0 = await unlock(p1.id, '');
t('空のパスワードは数えずに案内だけ', r0.status === 303 && r0.headers.get('Location').endsWith('?e=empty') && db.prepare('SELECT failed_count c FROM pages WHERE id=?').get(p1.id).c === 0);
const w1 = await unlock(p1.id, 'WRONG123');
t('違うパスワードは?e=wrong へ戻る', w1.status === 303 && w1.headers.get('Location') === '/s/' + p1.id + '/?e=wrong');
t('エラー文がロック画面に出る', (await (await call('/s/' + p1.id + '/?e=wrong')).text()).includes('パスワードが違います'));
for (let i = 0; i < VIEW.maxFailures - 2; i++) await unlock(p1.id, 'WRONG123');
const w5 = await unlock(p1.id, 'WRONG123');
t('連続5回の失敗でロック', w5.headers.get('Location').endsWith('?e=locked') && db.prepare('SELECT locked_until u FROM pages WHERE id=?').get(p1.id).u > Date.now() / 1000);
t('ロック中は正しいパスワードでも入れない', (await unlock(p1.id, p1.result.password)).headers.get('Location').endsWith('?e=locked'));
db.prepare('UPDATE pages SET locked_until = 0 WHERE id = ?').run(p1.id);
const views0 = db.prepare('SELECT COALESCE(SUM(count),0) c FROM views').get().c;
const okUnlock = await unlock(p1.id, p1.result.password.toLowerCase().replace(/(....)(....)/, '$1-$2'));
const viewUrl = okUnlock.headers.get('Location');
t('ロック解除後は小文字・ハイフン入りでも通り、閲覧URLへ移動', okUnlock.status === 303 && new RegExp('^/v/' + p1.id + '/\\d+\\.[a-f0-9]{64}/index\\.html$').test(viewUrl), viewUrl);
t('解除でビュー数が1増え、失敗回数が戻る', db.prepare('SELECT SUM(count) c FROM views').get().c === views0 + 1 && db.prepare('SELECT failed_count c FROM pages WHERE id=?').get(p1.id).c === 0);

// ── 閲覧 ──
const page = await call(viewUrl);
t('閲覧できる（sandbox・nosniff・no-store 付き）', page.status === 200 && (await page.clone().text()).includes('hello') && /^sandbox allow-scripts/.test(page.headers.get('Content-Security-Policy')) && page.headers.get('Cache-Control') === 'private, no-store' && page.headers.get('Access-Control-Allow-Origin') === null);
const css = await call(viewUrl.replace('index.html', 'css/a.css'));
t('相対パスのCSSが同じトークンで読め、型が正しい', css.status === 200 && css.headers.get('Content-Type') === 'text/css; charset=utf-8' && await css.text() === 'p{color:red}');
t('範囲指定(Range)は206', await (async () => { const r = await call(viewUrl.replace('index.html', 'css/a.css'), {headers: {Range: 'bytes=0-3'}}); return r.status === 206 && r.headers.get('Content-Range') === 'bytes 0-3/12' && await r.text() === 'p{co'; })());
t('存在しないファイルは404', (await call(viewUrl.replace('index.html', 'nope.css'))).status === 404);
t('隠しファイル・..は404', (await call(viewUrl.replace('index.html', '.env'))).status === 404 && (await call(viewUrl.replace('index.html', '%2e%2e/x'))).status === 404);
t('トークンなしでは読めない', (await call('/v/' + p1.id + '/x/index.html')).status === 404 && (await call('/v/' + p1.id + '/index.html')).status === 404);
const token = viewUrl.split('/')[3];
const p2 = await publish();
t('他のページ用のトークンは使えない', (await call('/v/' + p2.id + '/' + token + '/index.html')).status === 404);
t('署名を1文字変えると使えない', (await call('/v/' + p1.id + '/' + token.slice(0, -1) + (token.endsWith('0') ? '1' : '0') + '/index.html')).status === 404);
const past = await signViewToken(env.VIEW_TOKEN_SECRET, p1.id, Math.floor(Date.now() / 1000) - 5);
t('失効したトークンは使えない', (await call('/v/' + p1.id + '/' + past + '/index.html')).status === 404);
t('トークンの有効時間は最長2時間', Number(token.split('.')[0]) - Date.now() / 1000 <= VIEW.tokenSeconds + 5);

// 期限切れ・削除
db.prepare('UPDATE pages SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, p1.id);
t('期限が切れたページはロック画面も出ない（404）', (await call('/s/' + p1.id + '/')).status === 404);
t('期限が切れたページの解除も404', (await unlock(p1.id, p1.result.password)).status === 404);
const early = db.prepare('SELECT 1').get() && await (async () => {
  db.prepare('UPDATE pages SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) + 30, p2.id);
  const loc = (await unlock(p2.id, p2.result.password)).headers.get('Location');
  return Number(loc.split('/')[3].split('.')[0]);
})();
t('トークンの失効はページの期限を超えない', early <= Date.now() / 1000 + 31);

// ── 利用上限 ──
const now = Math.floor(Date.now() / 1000);
const alicesHash = row.owner_hash;
const fill = (n, createdAt, status = 'active') => { for (let i = 0; i < n; i++) db.prepare("INSERT INTO pages (id, title, status, owner_hash, files_json, file_count, total_bytes, created_at, expires_at, purge_at) VALUES (?, 't', ?, ?, '[]', 1, 1, ?, ?, ?)").run(crypto.randomUUID(), status, alicesHash, createdAt, now + 86400, now + 99999999); };
db.exec('DELETE FROM pages');
fill(LIMITS.perUserPerHour, now - 10);
const hourly = await call('/api/bundles', json(alice, manifest));
t('1時間に11回目の公開は429', hourly.status === 429 && (await hourly.json()).error.includes('1時間'));
db.exec('DELETE FROM pages');
fill(LIMITS.activePerUser, now - 7200);
const act = await call('/api/bundles', json(alice, manifest));
t('同時に有効なページが21件目は429', act.status === 429 && (await act.json()).error.includes('同時'));
t('別のユーザーには影響しない', (await call('/api/bundles', json(bob, manifest))).status === 200);
db.exec('DELETE FROM pages');
db.prepare("INSERT INTO pages (id, title, status, owner_hash, files_json, file_count, total_bytes, created_at, expires_at, purge_at) VALUES (?, 't', 'active', 'x', '[]', 1, ?, ?, ?, ?)").run(crypto.randomUUID(), LIMITS.capacityBytes, now - 7200, now + 86400, now + 99999999);
const cap = await call('/api/bundles', json(alice, manifest));
t('全体容量が9GBに達していたら507', cap.status === 507);
db.exec('DELETE FROM pages');
db.prepare("INSERT INTO pages (id, title, status, owner_hash, files_json, file_count, total_bytes, created_at, expires_at, purge_at) VALUES (?, 't', 'active', 'x', '[]', 1, ?, ?, ?, ?)").run(crypto.randomUUID(), LIMITS.capacityBytes, now - 7200, now - 10, now + 99999999);
t('期限切れのページは容量に数えない', (await call('/api/bundles', json(alice, manifest))).status === 200);

// ── その他 ──
t('未知のAPIは404', (await call('/api/unknown')).status === 404);
t('画面は静的ファイルを返す', await (await call('/')).text() === 'asset');
resetKeyCache();

if (failed) { console.log('\n' + failed + ' 件失敗'); process.exit(1); }
console.log('\nすべて成功');
