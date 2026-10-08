import http from 'node:http';

// Speaks just enough of the Stripe API for checkout and the customer portal,
// so billing can be tested without an account. Records what it was sent.
export async function startFakeStripe() {
  const state = { requests: [], status: 200 };
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
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
      return res.end(JSON.stringify({ id: 'cs_test_1', object: 'checkout.session', url: 'https://checkout.stripe.test/c/pay/cs_test_1' }));
    }
    if (req.method === 'POST' && req.url === '/v1/billing_portal/sessions') {
      return res.end(JSON.stringify({ id: 'bps_test_1', object: 'billing_portal.session', url: `https://billing.stripe.test/p/${form.customer}` }));
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
