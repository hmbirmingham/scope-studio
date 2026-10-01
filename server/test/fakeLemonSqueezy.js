import http from 'node:http';

// Speaks just enough of the Lemon Squeezy API to test checkout and the portal
// without an account. Records what it was sent.
export async function startFakeLemonSqueezy() {
  const state = { requests: [], status: 200 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    state.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, accept: req.headers.accept, body });
    res.setHeader('Content-Type', 'application/vnd.api+json');
    if (state.status !== 200) {
      res.writeHead(state.status);
      return res.end(JSON.stringify({ errors: [{ detail: 'variant not found' }] }));
    }
    if (req.method === 'POST' && req.url === '/v1/checkouts') {
      return res.end(JSON.stringify({ data: { type: 'checkouts', id: 'chk_1', attributes: { url: 'https://scope.lemonsqueezy.test/checkout/chk_1' } } }));
    }
    const match = req.url.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (req.method === 'GET' && match) {
      return res.end(JSON.stringify({ data: { type: 'subscriptions', id: match[1], attributes: { urls: { customer_portal: `https://scope.lemonsqueezy.test/portal/${match[1]}` } } } }));
    }
    res.writeHead(404);
    res.end(JSON.stringify({ errors: [{ detail: 'not found' }] }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return {
    url: `http://localhost:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}
