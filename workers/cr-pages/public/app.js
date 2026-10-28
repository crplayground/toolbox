// CR PAGES の画面。
// Phase 1：ファイルの受け取りと検証、期限の選択まで。ログインと公開（アップロード・URL発行）は Phase 2 以降。
import {EXPIRY_OPTIONS, DEFAULT_EXPIRY_HOURS, MAX_FILES, validateEntries} from './js/bundle.js';

const $ = id => document.getElementById(id);
const dropzone = $('dropzone'), selectedEl = $('selected'), errorEl = $('error');
let selected = null; // {files:[{path,file}], title}

// ── 期限のプルダウン ──
for (const o of EXPIRY_OPTIONS) {
  const opt = document.createElement('option');
  opt.value = String(o.hours);
  opt.textContent = o.label;
  if (o.hours === DEFAULT_EXPIRY_HOURS) opt.selected = true;
  $('expiry').appendChild(opt);
}

// ── ファイルの収集 ──
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
function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.toggle('hidden', !message);
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + 'MB' : Math.max(1, Math.round(bytes / 1024)) + 'KB';
}

async function accept(collect, folderName) {
  showError('');
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
    showError(e instanceof Error ? e.message : 'ファイルを読み込めませんでした。もう一度お試しください。');
  }
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
