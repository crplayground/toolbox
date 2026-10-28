// 公開するファイル一式の検証。ブラウザ（public/app.js）と Worker（src/）の両方がこのファイルを読む。
// DOM や Worker 固有のAPIは使わない（どちらでも動く純粋な関数だけを置く）。

export const MAX_FILE = 10 * 1024 * 1024;
export const MAX_TOTAL = 100 * 1024 * 1024;
export const MAX_FILES = 500;

// 閲覧できる期間（プルダウンの選択肢）。hours が正。
export const EXPIRY_OPTIONS = [
  {hours: 24, label: '24時間'},
  {hours: 72, label: '3日間'},
  {hours: 168, label: '7日間'},
  {hours: 336, label: '14日間'},
];
export const DEFAULT_EXPIRY_HOURS = 168;
export function isExpiryHours(hours) { return EXPIRY_OPTIONS.some(o => o.hours === hours); }

const types = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  txt: 'text/plain; charset=utf-8', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf',
};

// 隠しファイル（先頭が .）・バックスラッシュ・制御文字・%?#: を含むパスは拒否する。
export function validPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 512
    && !/[\\\x00-\x1f\x7f%?#:]/.test(path)
    && path.split('/').every(s => s.length > 0 && s !== '.' && s !== '..' && !s.startsWith('.'));
}

// 未対応の拡張子は undefined。
export function mime(path) {
  const name = path.split('/').pop();
  if (name === 'LICENSE') return 'text/plain; charset=utf-8';
  if (!name.includes('.')) return undefined;
  return types[name.split('.').pop().toLowerCase()];
}

// 集計用の種別。「作られたコード量」の目安として HTML／CSS／JS を分けて数える。
export function classify(path) {
  const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'css') return 'css';
  if (ext === 'js' || ext === 'mjs') return 'js';
  return 'other';
}

export function summarize(files) {
  const s = {files: files.length, bytes: 0, html: 0, css: 0, js: 0, other: 0};
  for (const f of files) { s.bytes += f.size; s[classify(f.path)] += f.size; }
  return s;
}

// 入力：[{path,size}]。問題があれば Error（メッセージは利用者にそのまま見せる）。
export function validateEntries(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_FILES) throw new Error('ファイル数は1〜500個にしてください。');
  const seen = new Set();
  let total = 0;
  const files = input.map(item => {
    if (!item || !validPath(item.path) || !mime(item.path)) throw new Error('未対応のファイル、または無効なパスです。');
    if (seen.has(item.path)) throw new Error('同じパスが重複しています。');
    seen.add(item.path);
    if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE) throw new Error('1ファイル10MB以内にしてください。');
    total += item.size;
    return {path: item.path, size: item.size};
  });
  if (total > MAX_TOTAL) throw new Error('フォルダ全体を100MB以内にしてください。');
  if (!files.some(f => f.path === 'index.html' && f.size > 0)) throw new Error('フォルダ直下に空ではないindex.htmlが必要です。');
  return files;
}

export function isId(id) {
  return typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
}
