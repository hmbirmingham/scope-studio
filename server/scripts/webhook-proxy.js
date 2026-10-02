import http from 'node:http';

// A public tunnel to the whole dev server would let anyone on the internet
// reach it as if from this machine — and screen actions trust requests from
// this machine. So the tunnel points here instead: only POST
// /api/billing/webhook is forwarded, with its exact bytes and the signature
// headers, and every other request is refused.
//
//   npm run webhook-proxy          (listens on 3002, forwards to 3001)
//   cloudflared tunnel --url http://localhost:3002

const LISTEN_PORT = Number(process.env.WEBHOOK_PROXY_PORT || 3002);
const TARGET = process.env.WEBHOOK_PROXY_TARGET || 'http://localhost:3001';
const PATH = '/api/billing/webhook';
const MAX_BYTES = 1024 * 1024;
const FORWARDED_HEADERS = ['content-type', 'x-signature', 'x-event-name'];

export function createWebhookProxy({ target = TARGET } = {}) {
  return http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        res.writeHead(413);
        return res.end('too large');
      }
      chunks.push(chunk);
    }
    const headers = Object.fromEntries(FORWARDED_HEADERS.filter((h) => req.headers[h]).map((h) => [h, req.headers[h]]));
    try {
      const upstream = await fetch(target + PATH, { method: 'POST', headers, body: Buffer.concat(chunks) });
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(await upstream.text());
      console.log(`${new Date().toISOString()} ${headers['x-event-name'] ?? '?'} → ${upstream.status}`);
    } catch (err) {
      res.writeHead(502);
      res.end('dev server unreachable');
      console.error(`forward failed: ${err.message}`);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createWebhookProxy().listen(LISTEN_PORT, () => {
    console.log(`webhook proxy on :${LISTEN_PORT} → ${TARGET}${PATH} (all other paths refused)`);
  });
}
