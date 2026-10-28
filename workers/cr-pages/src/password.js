// URL ごとのパスワード。8文字・32種類＝約40ビット。読み間違えやすい 0 O 1 I は使わない。
// 32 は 256 を割り切るので、1バイトの下位5ビットを使っても偏りは出ない。
export const PASSWORD_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PASSWORD_LENGTH = 8;

export function generatePassword(length = PASSWORD_LENGTH, random = crypto.getRandomValues.bind(crypto)) {
  const bytes = random(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += PASSWORD_ALPHABET[b & 31];
  return out;
}

// 入力欄の表記ゆれ（小文字・空白・ハイフン）を吸収する。
export function normalizePassword(input) {
  return String(input || '').toUpperCase().replace(/[\s-]/g, '');
}
