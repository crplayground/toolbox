// 配信まわりのヘッダーと共通レスポンス。

// アップロードされたファイルに必ず付ける。sandbox により、そのページはアプリと別の「出身不明」扱いになり、
// アプリの画面やログイン情報には触れない（localStorage・Cookie・フォーム送信も使えない）。
// allow-popups は target="_blank" のリンクを動かすため。
export const CONTENT_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'none'";

export function contentHeaders(contentType) {
  return new Headers({
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Security-Policy': CONTENT_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Cache-Control': 'private, no-store',
  });
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// 期限切れ・削除済み・存在しないページは、すべて同じ画面にする（理由を区別して見せない）。
export function notFoundResponse() {
  const html = '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex"><title>CR PAGES</title>'
    + '<body style="font-family:\'Noto Sans JP\',\'Hiragino Kaku Gothic ProN\',sans-serif;color:#333;background:#f5f5f5;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;line-height:2">'
    + '<div><p style="font-weight:700;font-size:18px;margin:0">このページは見つかりません。</p><p style="margin:0;color:#595959">期限が切れた可能性があります。</p></div></body></html>';
  const headers = contentHeaders('text/html; charset=utf-8');
  return new Response(html, {status: 404, headers});
}
