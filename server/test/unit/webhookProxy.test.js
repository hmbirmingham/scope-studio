import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { createWebhookProxy } from '../../scripts/webhook-proxy.js';

describe('webhook proxy', () => {
  let upstream;
  let proxy;
  let base;
  const received = [];

  before(async () => {
    upstream = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"applied":true}');
    });
    await new Promise((r) => upstream.listen(0, r));
    proxy = createWebhookProxy({ target: `http://localhost:${upstream.address().port}` });
    await new Promise((r) => proxy.listen(0, r));
    base = `http://localhost:${proxy.address().port}`;
  });
  after(async () => {
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => upstream.close(r));
  });

  test('forwards the webhook with its exact bytes and signature headers, and nothing else', async () => {
    const body = '{"meta":{"event_name":"subscription_created"},  "data":{}}';
    const response = await fetch(`${base}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': 'abc123', 'X-Event-Name': 'subscription_created', Cookie: 'connect.sid=steal-me' },
      body,
    });
    assert.equal(response.status, 200);
    const [got] = received;
    assert.equal(got.url, '/api/billing/webhook');
    assert.equal(got.body, body, 'byte for byte, so the HMAC still matches');
    assert.equal(got.headers['x-signature'], 'abc123');
    assert.equal(got.headers['x-event-name'], 'subscription_created');
    assert.equal(got.headers.cookie, undefined, 'no session cookie is passed through');
  });

  test('every other path and method is refused without reaching the server', async () => {
    const before = received.length;
    for (const [method, path] of [['GET', '/api/billing/webhook'], ['POST', '/api/chat'], ['POST', '/api/actions/x/approve'], ['GET', '/'], ['POST', '/api/billing/webhook/../../chat']]) {
      const response = await fetch(base + path, { method, body: method === 'POST' ? '{}' : undefined });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
    assert.equal(received.length, before);
  });
});
