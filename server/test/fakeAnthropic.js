import http from 'node:http';

// Speaks the Messages API's SSE shape so the cloud path can be tested without
// a key and without spending anything. Records what it was sent.
export async function startFakeAnthropic() {
  const state = { requests: [], authHeaders: [], text: ['Cloud ', 'answer.'], status: 200, inputTokens: 1200, outputTokens: 40 };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    state.requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    state.authHeaders.push(req.headers['x-api-key'] ?? null);

    if (state.status !== 200) {
      res.writeHead(state.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: state.inputTokens, output_tokens: 1 },
      },
    });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (const text of state.text) {
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    }
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: state.outputTokens },
    });
    send('message_stop', { type: 'message_stop' });
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
