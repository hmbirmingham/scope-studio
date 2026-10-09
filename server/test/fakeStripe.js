import http from 'node:http';

// Speaks just enough of the Stripe API for checkout and the customer portal,
// so billing can be tested without an account. Records what it was sent.
export async function startFakeStripe() {
  // `subscriptions` holds each subscription's current state, which the webhook
  // handler reads back with GET /v1/subscriptions/:id.
  const state = { requests: [], status: 200, subscriptions: {} };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    state.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, form });
    res.setHeader('Content-Type', 'application/json');
    if (state.status !== 200) {
      res.writeHead(state.status);
      return res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'No such price' } }));
    }
    if (req.method === 'POST' && req.url === '/v1/customers') {
      state.customers = (state.customers ?? 0) + 1;
      return res.end(JSON.stringify({ id: `cus_new_${state.customers}`, object: 'customer', email: form.email, metadata: { user_id: form['metadata[user_id]'] } }));
    }
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
      return res.end(JSON.stringify({ id: 'cs_test_1', object: 'checkout.session', url: 'https://checkout.stripe.test/c/pay/cs_test_1' }));
    }
    if (req.method === 'POST' && req.url === '/v1/billing_portal/sessions') {
      return res.end(JSON.stringify({ id: 'bps_test_1', object: 'billing_portal.session', url: `https://billing.stripe.test/p/${form.customer}` }));
    }
    const sub = req.url.match(/^\/v1\/subscriptions\/([^/?]+)/);
    if (req.method === 'GET' && sub && state.subscriptions[sub[1]]) {
      return res.end(JSON.stringify(state.subscriptions[sub[1]]));
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'not found' } }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return {
    url: `http://localhost:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}
