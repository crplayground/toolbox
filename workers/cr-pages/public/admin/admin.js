// HELLO PAGES 管理者ボード。見られるのは管理者だけ（データ API が管理者以外には 404 を返す）。
// ログインは公開画面（app.js）と同じ方式。
const $ = id => document.getElementById(id);
const HOSTED_DOMAIN = 'crazy.co.jp';
let auth = {idToken: null, exp: 0};
let codeClient = null;

function parseJwtPayload(token) {
  try {
    const b = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(Array.prototype.map.call(atob(b.padEnd(Math.ceil(b.length / 4) * 4, '=')), c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')));
  } catch { return null; }
}

function setLoginHint(message) { $('loginHint').textContent = message || '@crazy.co.jp のアカウントでログインしてください。'; }
function show(id, on) { $(id).classList.toggle('hidden', !on); }

function applySignedIn(p) {
  auth = {idToken: p.idToken, exp: p.exp || 0};
  show('loginBox', false);
  show('userBox', true);
  setLoginHint('');
  void loadStats();
}

function signOut() {
  auth = {idToken: null, exp: 0};
  show('userBox', false);
  show('loginBox', true);
  show('stats', false);
  show('notFound', false);
  show('statsError', false);
  try { window.google?.accounts.id.disableAutoSelect(); } catch { /* 無視 */ }
}

function onOneTap(res) {
  if (!res || !res.credential) return;
  const p = parseJwtPayload(res.credential);
  if (!p) { setLoginHint('ログイン情報を読み取れませんでした。ボタンからログインしてください。'); return; }
  if (p.hd !== HOSTED_DOMAIN || !/@crazy\.co\.jp$/i.test(String(p.email || ''))) {
    setLoginHint('@crazy.co.jp のアカウントでログインしてください。');
    try { window.google.accounts.id.disableAutoSelect(); } catch { /* 無視 */ }
    return;
  }
  applySignedIn({idToken: res.credential, exp: p.exp});
}

async function onCode(res) {
  const btn = $('loginBtn');
  if (!res || !res.code) { setLoginHint('ログインがキャンセルされました。もう一度お試しください。'); btn.disabled = false; return; }
  try {
    const r = await fetch('/api/auth/exchange', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code: res.code})});
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'ログインに失敗しました。');
    applySignedIn(j);
  } catch (e) { setLoginHint(e instanceof Error ? e.message : 'ログインに失敗しました。'); }
  finally { btn.disabled = false; }
}

async function initAuth() {
  let clientId = '';
  try { clientId = (await (await fetch('/api/config')).json()).clientId; } catch { /* 下で案内 */ }
  if (!clientId) { setLoginHint('ログインの設定が完了していません。'); $('loginBtn').disabled = true; return; }
  const ready = () => window.google && window.google.accounts && window.google.accounts.id && window.google.accounts.oauth2;
  for (let i = 0; i < 50 && !ready(); i++) await new Promise(r => setTimeout(r, 200));
  if (!ready()) { setLoginHint('Googleのログイン機能を読み込めませんでした。ページを再読み込みしてください。'); return; }
  try {
    window.google.accounts.id.initialize({client_id: clientId, callback: onOneTap, auto_select: true, itp_support: true, use_fedcm_for_prompt: true, context: 'signin'});
    window.google.accounts.id.prompt();
  } catch { /* ボタンで進める */ }
  codeClient = window.google.accounts.oauth2.initCodeClient({client_id: clientId, scope: 'openid email profile', ux_mode: 'popup', hd: HOSTED_DOMAIN, callback: onCode});
}

$('loginBtn').addEventListener('click', () => {
  setLoginHint('');
  if (!codeClient) { setLoginHint('Googleのログイン機能をまだ読み込めていません。数秒おいて、もう一度押してください。'); return; }
  $('loginBtn').disabled = true;
  try { codeClient.requestCode(); } catch { $('loginBtn').disabled = false; setLoginHint('ログイン画面を開けませんでした。ポップアップがブロックされていないか確認してください。'); }
});
$('switchUser').addEventListener('click', signOut);
void initAuth();

// ===== 集計の表示 =========================================================
const n = v => Number(v || 0).toLocaleString('ja-JP');
function size(bytes) {
  bytes = Number(bytes || 0);
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

function renderTable(table, rows, label) {
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  for (const h of [label, '公開ページ', 'ビュー数', '利用ユーザー', 'ファイル数', '容量', 'HTML', 'CSS', 'JS']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = h;
    head.append(th);
  }
  const max = Math.max(1, ...rows.map(r => r.pages));
  const body = table.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = r.key;
    tr.append(th);
    const pages = tr.insertCell();
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.style.setProperty('--w', Math.round((r.pages / max) * 100) + '%');
    const num = document.createElement('span');
    num.textContent = n(r.pages);
    pages.append(num, bar);
    for (const v of [n(r.views), n(r.users), n(r.files), size(r.bytes), size(r.html), size(r.css), size(r.js)]) tr.insertCell().textContent = v;
  }
}

async function loadStats() {
  show('notFound', false);
  show('statsError', false);
  show('stats', false);
  try {
    const response = await fetch('/api/admin/stats', {headers: {Authorization: 'Bearer ' + auth.idToken}});
    if (response.status === 404) { show('notFound', true); return; }
    if (response.status === 401) { signOut(); setLoginHint('ログインの有効期限が切れました。もう一度ログインしてください。'); return; }
    if (!response.ok) throw new Error('読み込めませんでした。時間をおいて、もう一度お試しください。');
    const s = await response.json();
    $('sActive').textContent = n(s.current.activePages);
    $('sBytes').textContent = size(s.current.bytes);
    $('sCap').textContent = '上限 ' + size(s.current.capacityBytes) + ' の ' + (s.current.bytes / s.current.capacityBytes * 100).toFixed(1) + '%';
    $('sPages').textContent = n(s.totals.pages);
    $('sViews').textContent = n(s.totals.views);
    $('sUsers').textContent = n(s.totals.users);
    $('sFiles').textContent = n(s.totals.files);
    $('sFilesBytes').textContent = size(s.totals.bytes) + '（HTML ' + size(s.totals.html) + ' ／ CSS ' + size(s.totals.css) + ' ／ JS ' + size(s.totals.js) + '）';
    renderTable($('monthTable'), s.months, '月');
    renderTable($('yearTable'), s.years, '年');
    show('stats', true);
  } catch (e) {
    $('statsError').textContent = e instanceof Error ? e.message : '読み込めませんでした。';
    show('statsError', true);
  }
}
