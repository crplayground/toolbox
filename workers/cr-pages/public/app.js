// CR PAGES の画面。
// ログイン（Creative Process と同じ方式）→ ファイルの受け取りと検証 → 公開（URLとパスワードの発行）。
import {EXPIRY_OPTIONS, DEFAULT_EXPIRY_HOURS, MAX_FILES, validateEntries} from './js/bundle.js';

const $ = id => document.getElementById(id);
const dropzone = $('dropzone'), selectedEl = $('selected'), errorEl = $('error');
let selected = null; // {files:[{path,file}], title}
let auth = {idToken: null, name: '', email: '', exp: 0};
let busy = false;

// ── 期限のプルダウン ──
for (const o of EXPIRY_OPTIONS) {
  const opt = document.createElement('option');
  opt.value = String(o.hours);
  opt.textContent = o.label;
  if (o.hours === DEFAULT_EXPIRY_HOURS) opt.selected = true;
  $('expiry').appendChild(opt);
}

// ===== Googleログイン =====================================================
// ① One Tap（自動）… ブラウザで会社のGoogleにサインイン済みなら、ボタンを押さずにログイン済みになる。IDトークンを直接受け取る。
// ② 自作ボタン（手動）… One Tap が出せない環境や、別アカウントに切り替えたいとき。認可コードをWorkerがIDトークンに交換する。
// どちらでも、最終判定はWorker側の署名検証。IDトークンはブラウザのメモリだけに持つ（再読み込みで One Tap が再びログインする）。
const HOSTED_DOMAIN = 'crazy.co.jp';
let codeClient = null;

function parseJwtPayload(token) {
  try {
    const b = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(Array.prototype.map.call(atob(b.padEnd(Math.ceil(b.length / 4) * 4, '=')), c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')));
  } catch { return null; }
}

function setLoginHint(message) { $('loginHint').textContent = message || '@crazy.co.jp のアカウントでログインしてください。'; }

function expired() { return !auth.exp || auth.exp * 1000 < Date.now() + 60 * 1000; }

function refreshPublish() { $('publishBtn').disabled = busy || !auth.idToken || !selected; }

function applySignedIn(p) {
  auth = {idToken: p.idToken, name: p.name || p.email || '', email: p.email || '', exp: p.exp || 0};
  $('userName').textContent = auth.name;
  $('userEmail').textContent = auth.email;
  $('loginBox').classList.add('hidden');
  $('userBox').classList.remove('hidden');
  setLoginHint('');
  refreshPublish();
}

function signOut() {
  auth = {idToken: null, name: '', email: '', exp: 0};
  $('userBox').classList.add('hidden');
  $('loginBox').classList.remove('hidden');
  // 自動ログインを切る。これをしないと「別のアカウント」を押しても同じ人で入り直してしまう。
  try { window.google?.accounts.id.disableAutoSelect(); } catch { /* 無視 */ }
  refreshPublish();
}

function onOneTap(res) {
  if (!res || !res.credential) return;
  const p = parseJwtPayload(res.credential);
  if (!p) { setLoginHint('ログイン情報を読み取れませんでした。ボタンからログインしてください。'); return; }
  // 先回りの確認。最終判定はWorker側
  if (p.hd !== HOSTED_DOMAIN || !/@crazy\.co\.jp$/i.test(String(p.email || ''))) {
    setLoginHint('@crazy.co.jp のアカウントでログインしてください（' + p.email + ' は使用できません）。');
    try { window.google.accounts.id.disableAutoSelect(); } catch { /* 無視 */ }
    return;
  }
  applySignedIn({idToken: res.credential, name: p.name || p.email, email: p.email, exp: p.exp});
}

async function onCode(res) {
  const btn = $('loginBtn');
  if (!res || !res.code) { setLoginHint('ログインがキャンセルされました。もう一度お試しください。'); btn.disabled = false; return; }
  try {
    const r = await fetch('/api/auth/exchange', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code: res.code})});
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'ログインに失敗しました。');
    applySignedIn(j);
  } catch (e) {
    setLoginHint(e instanceof Error ? e.message : 'ログインに失敗しました。');
  } finally { btn.disabled = false; }
}

async function initAuth() {
  let clientId = '';
  try { clientId = (await (await fetch('/api/config')).json()).clientId; } catch { /* 下で案内 */ }
  if (!clientId) { setLoginHint('ログインの設定が完了していません。管理者に連絡してください。'); $('loginBtn').disabled = true; return; }
  const ready = () => window.google && window.google.accounts && window.google.accounts.id && window.google.accounts.oauth2;
  for (let i = 0; i < 50 && !ready(); i++) await new Promise(r => setTimeout(r, 200));
  if (!ready()) { setLoginHint('Googleのログイン機能を読み込めませんでした。ページを再読み込みしてください。'); return; }
  try {
    window.google.accounts.id.initialize({client_id: clientId, callback: onOneTap, auto_select: true, itp_support: true, use_fedcm_for_prompt: true, context: 'signin'});
    window.google.accounts.id.prompt(); // 出せない環境では黙って出ないだけ。自作ボタンが残る
  } catch { /* 自作ボタンで進める */ }
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

// ===== ファイルの収集 ====================================================
// ドロップされたフォルダを再帰的に読む。隠しファイル（先頭が .）は除外する。
async function scan(entry, prefix = '', out = []) {
  if (entry.name.startsWith('.')) return out;
  const path = prefix + entry.name;
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({path, file});
    if (out.length > MAX_FILES) throw new Error('500ファイル以内のフォルダを選んでください。');
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const children = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!children.length) break;
      for (const child of children) await scan(child, path + '/', out);
    }
  }
  return out;
}

function fromPicker(fileList) {
  return Array.from(fileList)
    .map(file => ({file, path: file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name}))
    .filter(f => !f.path.split('/').some(p => p.startsWith('.')));
}

// index.html が参照する CSS・JS・画像が、選んだ中に入っているか確認する（絶対パスは未対応）。
async function checkAssets(files) {
  const index = files.find(f => f.path === 'index.html');
  if (!index) return;
  const doc = new DOMParser().parseFromString(await index.file.text(), 'text/html');
  if (doc.querySelector('base[href]')) return;
  const names = new Set(files.map(f => f.path));
  const missing = [];
  for (const node of doc.querySelectorAll('link[rel="stylesheet"][href],script[src],img[src],source[src],video[src],audio[src]')) {
    const ref = node.getAttribute('src') || node.getAttribute('href') || '';
    if (!ref || /^(?:[a-z]+:|\/\/|#)/i.test(ref)) continue;
    if (ref.startsWith('/')) throw new Error('「/」から始まる素材パスは未対応です。「./css/…」などの相対パスにしてください。');
    const path = decodeURIComponent(new URL(ref, 'https://bundle.invalid/index.html').pathname.slice(1));
    if (!names.has(path)) missing.push(path);
  }
  if (missing.length) throw new Error('素材が足りません（' + [...new Set(missing)].slice(0, 3).join('、') + '）。index.htmlとcss・assetsなどが入ったフォルダごと選んでください。');
}

async function pageTitle(files, fallback) {
  const index = files.find(f => f.path === 'index.html');
  const title = index ? new DOMParser().parseFromString(await index.file.text(), 'text/html').title.trim() : '';
  return (title || fallback || '無題').slice(0, 60);
}

// ── 選択 → 検証 ──
function showError(el, message) {
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + 'MB' : Math.max(1, Math.round(bytes / 1024)) + 'KB';
}

async function accept(collect, folderName) {
  if (busy) return;
  showError(errorEl, '');
  showError($('publishError'), '');
  selected = null;
  selectedEl.classList.add('hidden');
  try {
    let files = await collect();
    // HTMLが1つだけなら、そのファイルを index.html として公開する
    if (files.length === 1 && /\.html?$/i.test(files[0].path)) files = [{...files[0], path: 'index.html'}];
    validateEntries(files.map(f => ({path: f.path, size: f.file.size})));
    await checkAssets(files);
    const total = files.reduce((n, f) => n + f.file.size, 0);
    selected = {files, title: await pageTitle(files, folderName)};
    selectedEl.textContent = '選択中：' + selected.title + '（' + files.length + 'ファイル・' + formatSize(total) + '）';
    selectedEl.classList.remove('hidden');
  } catch (e) {
    showError(errorEl, e instanceof Error ? e.message : 'ファイルを読み込めませんでした。もう一度お試しください。');
  }
  refreshPublish();
}

dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('over');
  const entries = Array.from(e.dataTransfer.items).filter(i => i.kind === 'file').map(i => i.webkitGetAsEntry());
  const fallback = Array.from(e.dataTransfer.files);
  const dir = entries.length === 1 && entries[0] && entries[0].isDirectory ? entries[0].name : '';
  void accept(async () => {
    if (entries.length && entries.every(Boolean)) {
      const out = [];
      for (const entry of entries) await scan(entry, '', out);
      // フォルダを1つだけ落とした場合は、そのフォルダ名の階層を取り除く
      return dir ? out.map(f => ({...f, path: f.path.split('/').slice(1).join('/')})) : out;
    }
    return fallback.map(file => ({file, path: file.name}));
  }, dir);
});

$('pickFolder').addEventListener('click', () => $('folderInput').click());
$('pickHtml').addEventListener('click', () => $('htmlInput').click());
$('folderInput').addEventListener('change', e => {
  const list = e.target.files;
  if (list && list.length) void accept(async () => fromPicker(list), list[0].webkitRelativePath.split('/')[0]);
  e.target.value = '';
});
$('htmlInput').addEventListener('change', e => {
  const list = e.target.files;
  if (list && list.length) void accept(async () => fromPicker(list), list[0].name.replace(/\.html?$/i, ''));
  e.target.value = '';
});

// ===== 公開（URLとパスワードの発行）=======================================
async function api(url, init) {
  const response = await fetch(url, {...init, headers: {...(init.headers || {}), Authorization: 'Bearer ' + auth.idToken}});
  if (!response.ok) {
    let message = '公開に失敗しました。もう一度お試しください。';
    try { message = (await response.json()).error || message; } catch { /* 既定の文言 */ }
    if (response.status === 401) { signOut(); message = 'ログインの有効期限が切れました。もう一度ログインしてください。'; }
    throw new Error(message);
  }
  return response.json();
}

function formatDate(epochSeconds) {
  const d = new Date(epochSeconds * 1000), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ' まで';
}

let lastResult = null;

async function publish() {
  if (busy || !selected) return;
  if (!auth.idToken || expired()) { signOut(); showError($('publishError'), 'ログインの有効期限が切れました。もう一度ログインしてください。'); return; }
  busy = true;
  showError($('publishError'), '');
  const button = $('publishBtn');
  refreshPublish();
  try {
    const {files, title} = selected;
    button.textContent = '公開の準備中…';
    const {id} = await api('/api/bundles', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({title, expiryHours: Number($('expiry').value), files: files.map(f => ({path: f.path, size: f.file.size}))})});
    let next = 0, done = 0, failure;
    await Promise.all(Array.from({length: Math.min(4, files.length)}, async () => {
      while (!failure) {
        const i = next++;
        if (i >= files.length) return;
        try {
          await api('/api/bundles/' + id + '/file?path=' + encodeURIComponent(files[i].path), {method: 'PUT', headers: {'Content-Type': 'application/octet-stream'}, body: files[i].file});
          done++;
          button.textContent = done + ' / ' + files.length + ' ファイルを送信中…';
        } catch (e) { failure = e; }
      }
    }));
    if (failure) throw failure;
    button.textContent = '確認中…';
    lastResult = await api('/api/bundles/' + id + '/complete', {method: 'POST'});
    showResult(lastResult);
  } catch (e) {
    showError($('publishError'), e instanceof Error ? e.message : '公開に失敗しました。もう一度お試しください。');
  } finally {
    busy = false;
    button.textContent = '公開してURLを発行する';
    refreshPublish();
  }
}

function showResult(r) {
  $('resultPage').textContent = r.title;
  $('resultUrl').value = r.url;
  $('resultPassword').textContent = r.password;
  $('resultExpiry').textContent = formatDate(r.expiresAt);
  $('openPage').href = r.url;
  $('result').classList.remove('hidden');
  selected = null;
  selectedEl.classList.add('hidden');
  $('result').scrollIntoView({behavior: 'smooth', block: 'start'});
}

$('publishBtn').addEventListener('click', () => void publish());
$('resultUrl').addEventListener('focus', e => e.target.select());
$('copyAll').addEventListener('click', async () => {
  if (!lastResult) return;
  const text = '【' + lastResult.title + '】\nURL: ' + lastResult.url + '\nパスワード: ' + lastResult.password + '\n期限: ' + formatDate(lastResult.expiresAt);
  const button = $('copyAll');
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'コピーしました ✓';
    setTimeout(() => { button.textContent = 'URLとパスワードをまとめてコピー'; }, 2200);
  } catch { showError($('publishError'), 'コピーできませんでした。URLとパスワードを選択してコピーしてください。'); }
});
$('again').addEventListener('click', () => {
  lastResult = null;
  $('result').classList.add('hidden');
  $('resultPassword').textContent = '';
  $('resultUrl').value = '';
  window.scrollTo({top: 0, behavior: 'smooth'});
});

refreshPublish();
