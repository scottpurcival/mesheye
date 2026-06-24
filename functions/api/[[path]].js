export async function onRequest(context) {
  const url = new URL(context.request.url);
  const target = `https://core.eastmesh.au${url.pathname}${url.search}`;

  const res = await fetch(target, {
    method: context.request.method,
    headers: context.request.headers,
    body: context.request.method !== 'GET' && context.request.method !== 'HEAD'
      ? context.request.body
      : undefined,
  });

  // Strip hop-by-hop headers that can't be forwarded.
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');

  return new Response(res.body, { status: res.status, headers });
}
