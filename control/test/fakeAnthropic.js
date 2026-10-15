import http from 'node:http';

// Speaks the Messages API's SSE shape so the platform cloud can be tested
// without a key and without spending anything. Records what it was sent.
// Copied from server/test/fakeAnthropic.js without the web search parts (the
// control plane never offers search), and extended for what only the control
// plane needs: cache usage, an answer that never finishes, a failure partway
// through, and a count of connections the client dropped.
export function freshState() {
  return {
    requests: [], authHeaders: [], text: ['Cloud ', 'answer.'], status: 200,
    inputTokens: 1200, outputTokens: 40, cacheCreationTokens: 0, cacheReadTokens: 0,
    // `hold` sends the text and then waits, with the message unfinished, until
    // the client hangs up. `failMidStream` sends the text and then an error event.
    hold: false, failMidStream: false,
    dropped: 0,
  };
}

export async function startFakeAnthropic() {
  const state = freshState();

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    state.requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    state.authHeaders.push(req.headers['x-api-key'] ?? null);
    res.on('close', () => {
      if (!res.writableEnded) state.dropped += 1;
    });

    // Mirrors the real API: Haiku 4.5 refuses the effort parameter.
    const sent = state.requests.at(-1);
    if (sent.model === 'claude-haiku-4-5' && sent.output_config?.effort) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'This model does not support the effort parameter.' } }));
    }

    if (state.status !== 200) {
      res.writeHead(state.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_test', type: 'message', role: 'assistant', model: sent.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: {
          input_tokens: state.inputTokens, output_tokens: 1,
          cache_creation_input_tokens: state.cacheCreationTokens, cache_read_input_tokens: state.cacheReadTokens,
        },
      },
    });

    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (const text of state.text) {
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    }
    if (state.hold) return; // The client's hang-up is what ends this one.
    if (state.failMidStream) {
      // The upstream text here deliberately quotes the prompt, as a real
      // provider error might, so a test can check it never reaches the client.
      const echoed = JSON.stringify(sent.messages).slice(0, 200);
      send('error', { type: 'error', error: { type: 'overloaded_error', message: `Overloaded while reading ${echoed}` } });
      return res.end();
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
    reset: () => Object.assign(state, freshState()),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
