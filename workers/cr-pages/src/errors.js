// 利用者にそのまま見せてよいメッセージを持つエラー。それ以外のエラーは内容を隠して500にする。
import {jsonResponse} from './headers.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function errorResponse(e) {
  if (e instanceof HttpError) return jsonResponse({error: e.message}, e.status);
  console.error('[cr-pages]', e && e.message ? e.message : e);
  return jsonResponse({error: '処理に失敗しました。時間をおいて、もう一度お試しください。'}, 500);
}
