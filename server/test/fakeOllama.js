import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { localChatModel } from '../src/lib/ollama.js';

async function readBody(req) {
  const parts = [];
  for await (const part of req) parts.push(part);
  return Buffer.concat(parts);
}

// Stands in for Ollama's chat endpoint so generation is deterministic and
// needs no 6 GB model in CI. Embeddings are proxied to the real Ollama when it
// is reachable; otherwise retrieval runs lexical-only, as it does in production.
export async function startFakeOllama({ embedUrl } = {}) {
  const state = {
    models: ['nomic-embed-text:latest', localChatModel()],
    tokens: ['Returns ', 'a naïve ', 'count — ', 'done.'],
    pauseAfterFirstMs: 0,
    failAfterFirst: null,
    chatRequests: [],
    aborted: 0,
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ models: state.models.map((name) => ({ name, model: name })) }));
    }

    const body = await readBody(req);
    if (req.url === '/api/embed') {
      try {
        const upstream = await fetch(`${embedUrl}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        return res.end(await upstream.text());
      } catch {
        res.writeHead(503);
        return res.end();
      }
    }

    if (req.url === '/api/chat') {
      const request = JSON.parse(body);
      state.chatRequests.push(request);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      let closed = false;
      res.on('close', () => {
        if (!res.writableEnded) {
          closed = true;
          state.aborted += 1;
        }
      });

      for (const [i, token] of state.tokens.entries()) {
        if (closed) return;
        // Every line is written in two halves, split by bytes, so the client
        // must reassemble partial lines and partial UTF-8 sequences.
        const line = Buffer.from(`${JSON.stringify({ message: { role: 'assistant', content: token }, done: false })}\n`);
        const cut = Math.floor(line.length / 2);
        res.write(line.subarray(0, cut));
        await sleep(1);
        res.write(line.subarray(cut));
        if (i === 0 && state.failAfterFirst) {
          return res.end(`${JSON.stringify({ error: state.failAfterFirst })}\n`);
        }
        if (i === 0 && state.pauseAfterFirstMs) await sleep(state.pauseAfterFirstMs);
      }
      if (closed) return;
      return res.end(
        `${JSON.stringify({
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
          eval_count: state.tokens.length,
          prompt_eval_count: 321,
        })}\n`
      );
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, resolve));
  return {
    url: `http://localhost:${server.address().port}`,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// A URL where nothing listens: the port was just released.
export async function deadUrl() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://localhost:${port}`;
}
