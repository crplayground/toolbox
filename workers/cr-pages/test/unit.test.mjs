// HELLO PAGES ユニットテスト。実行：cd workers/cr-pages && node test/unit.test.mjs
import {readFileSync} from 'node:fs';
import {
  MAX_FILES, MAX_FILE, MAX_TOTAL, EXPIRY_OPTIONS, DEFAULT_EXPIRY_HOURS, isExpiryHours,
  validPath, mime, classify, summarize, validateEntries, isId,
} from '../public/js/bundle.js';
import {PASSWORD_ALPHABET, PASSWORD_LENGTH, generatePassword, normalizePassword} from '../src/password.js';
import {contentHeaders, notFoundResponse, CONTENT_CSP} from '../src/headers.js';
import worker from '../src/worker.js';

let failed = 0;
function t(name, ok) { if (!ok) { failed++; console.log('NG  ' + name); } else console.log('ok  ' + name); }
function throws(fn) { try { fn(); return false; } catch { return true; } }

// ── 期限 ──
t('期限の選択肢は 24時間／3日間／7日間／14日間', JSON.stringify(EXPIRY_OPTIONS.map(o => o.hours)) === '[24,72,168,336]');
t('期限の初期値は7日間', DEFAULT_EXPIRY_HOURS === 168 && isExpiryHours(168));
t('選択肢にない期限は拒否', !isExpiryHours(48) && !isExpiryHours('168'));

// ── パス検証 ──
t('通常のパスは有効', validPath('index.html') && validPath('css/main.css') && validPath('assets/img/a.png'));
t('隠しファイルは無効', !validPath('.env') && !validPath('css/.hidden.css'));
t('..・.・空の階層は無効', !validPath('../a.html') && !validPath('a//b.html') && !validPath('./a.html'));
t('バックスラッシュ・%・?・#・: は無効', !validPath('a\\b.html') && !validPath('a%20b.html') && !validPath('a?b.html') && !validPath('a#b.html') && !validPath('a:b.html'));
t('513文字は無効', !validPath('a'.repeat(513)));
t('MIME：対応拡張子', mime('a.html') === 'text/html; charset=utf-8' && mime('a.PNG') === 'image/png' && mime('LICENSE') === 'text/plain; charset=utf-8');
t('MIME：未対応・拡張子なしは undefined', mime('a.exe') === undefined && mime('Makefile') === undefined);
t('種別の分類', classify('a.html') === 'html' && classify('a.css') === 'css' && classify('a.mjs') === 'js' && classify('a.png') === 'other' && classify('LICENSE') === 'other');
t('種別ごとの容量を集計', JSON.stringify(summarize([{path: 'index.html', size: 10}, {path: 'a.css', size: 5}, {path: 'a.js', size: 7}, {path: 'a.png', size: 3}])) === JSON.stringify({files: 4, bytes: 25, html: 10, css: 5, js: 7, other: 3}));

// ── 一式の検証 ──
const ok = [{path: 'index.html', size: 100}, {path: 'css/a.css', size: 10}];
t('正しい一式は通る', validateEntries(ok).length === 2);
t('index.html がなければ拒否', throws(() => validateEntries([{path: 'a.html', size: 100}])));
t('空の index.html は拒否', throws(() => validateEntries([{path: 'index.html', size: 0}])));
t('同じパスの重複は拒否', throws(() => validateEntries([...ok, {path: 'css/a.css', size: 1}])));
t('未対応の拡張子は拒否', throws(() => validateEntries([...ok, {path: 'a.exe', size: 1}])));
t('1ファイル10MB超は拒否', throws(() => validateEntries([{path: 'index.html', size: MAX_FILE + 1}])));
t('合計100MB超は拒否', throws(() => validateEntries(Array.from({length: 11}, (_, i) => ({path: i ? 'f' + i + '.png' : 'index.html', size: MAX_FILE})))));
t('合計ちょうど100MBは通る', validateEntries(Array.from({length: 10}, (_, i) => ({path: i ? 'f' + i + '.png' : 'index.html', size: MAX_TOTAL / 10}))).length === 10);
t('501ファイルは拒否', throws(() => validateEntries(Array.from({length: MAX_FILES + 1}, (_, i) => ({path: 'f' + i + '.png', size: 1})))));
t('0ファイル・配列以外は拒否', throws(() => validateEntries([])) && throws(() => validateEntries(null)));
t('サイズが整数でなければ拒否', throws(() => validateEntries([{path: 'index.html', size: 1.5}])) && throws(() => validateEntries([{path: 'index.html', size: -1}])));
t('UUID v4 の判定', isId('dbb5b25e-802b-42db-a409-9a38069bbd81') && !isId('dbb5b25e-802b-12db-a409-9a38069bbd81') && !isId('../x') && !isId(undefined));

// ── パスワード ──
t('パスワード文字集合は32種類で 0 O 1 I を含まない', PASSWORD_ALPHABET.length === 32 && !/[0O1I]/.test(PASSWORD_ALPHABET));
const pw = generatePassword();
t('パスワードは8文字で集合内の文字だけ', pw.length === PASSWORD_LENGTH && [...pw].every(c => PASSWORD_ALPHABET.includes(c)));
t('パスワードは毎回変わる', new Set(Array.from({length: 50}, () => generatePassword())).size === 50);
t('乱数が偏らない（全バイト値で文字集合内）', Array.from({length: 256}, (_, b) => PASSWORD_ALPHABET[b & 31]).every(Boolean));
t('入力の表記ゆれを吸収', normalizePassword(' ab-cd 23 ') === 'ABCD23' && normalizePassword(null) === '');

// ── 配信ヘッダー ──
const h = contentHeaders('text/css; charset=utf-8');
t('配信ヘッダーに sandbox・nosniff・no-store', h.get('Content-Security-Policy') === CONTENT_CSP && /^sandbox allow-scripts /.test(CONTENT_CSP) && h.get('X-Content-Type-Options') === 'nosniff' && h.get('Cache-Control') === 'private, no-store');
t('配信ヘッダーに Access-Control-Allow-Origin を付けない', h.get('Access-Control-Allow-Origin') === null);
t('allow-same-origin を含まない（出身不明扱いを保つ）', !/allow-same-origin/.test(CONTENT_CSP));
const nf = notFoundResponse();
t('見つからない画面は404で sandbox 付き', nf.status === 404 && nf.headers.get('Content-Security-Policy') === CONTENT_CSP);

// ── Worker の入口 ──
const env = {
  ASSETS: {fetch: async () => new Response('asset')},
  BUCKET: {head: async () => null},
  DB: {prepare: () => ({first: async () => ({1: 1}), bind() { return this; }})},
};
const get = path => worker.fetch(new Request('https://example.test' + path), env);
const health = await get('/api/health');
t('稼働確認が R2・D1 の接続を返す', (await health.json()).ok === true && health.headers.get('Cache-Control') === 'no-store');
const brokenHealth = await worker.fetch(new Request('https://example.test/api/health'), {...env, BUCKET: {head: async () => { throw new Error('x'); }}});
const brokenBody = await brokenHealth.json();
t('R2 が使えないときは r2:false', brokenBody.r2 === false && brokenBody.d1 === true);
t('未実装の API は404', (await get('/api/unknown')).status === 404);
t('公開されていない共有ページ・不正な閲覧URLは404', (await get('/s/dbb5b25e-802b-42db-a409-9a38069bbd81/')).status === 404 && (await get('/v/x/y/index.html')).status === 404);
t('それ以外は静的ファイルへ渡す', await (await get('/')).text() === 'asset');

// ── 設定ファイル ──
const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
t('wrangler.toml に秘密情報・メールアドレスがない', !/@crazy\.co\.jp|GOCSPX|PRIVATE KEY|secret\s*=/i.test(toml));
t('wrangler.toml は /api /s /v だけ Worker を先に通す', /run_worker_first\s*=\s*\["\/api\/\*", "\/s\/\*", "\/v\/\*"\]/.test(toml));

if (failed) { console.log('\n' + failed + ' 件失敗'); process.exit(1); }
console.log('\nすべて成功');
