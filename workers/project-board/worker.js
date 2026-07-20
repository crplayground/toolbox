export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization,Content-Type,Notion-Version',
        },
      });
    }

    const url = new URL(request.url);
    const notionUrl = 'https://api.notion.com' + url.pathname + url.search;

    const headers = new Headers();
    for (const [k, v] of request.headers) {
      if (['authorization','content-type','notion-version'].includes(k.toLowerCase())) {
        headers.set(k, v);
      }
    }

    const res = await fetch(notionUrl, {
      method: request.method,
      headers,
      body: ['GET','HEAD'].includes(request.method) ? null : request.body,
    });

    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },
};
