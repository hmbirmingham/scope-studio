import http from 'node:http';

// Speaks the Messages API's SSE shape so the cloud path can be tested without
// a key and without spending anything. Records what it was sent.
export async function startFakeAnthropic() {
  // `search`, when set, makes the first response run one web search and cite
  // its result; `pauseAfterSearch` ends that first response with pause_turn so
  // the client has to resume it.
  const state = {
    requests: [], authHeaders: [], text: ['Cloud ', 'answer.'], status: 200, inputTokens: 1200, outputTokens: 40,
    search: null, pauseAfterSearch: false,
  };

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

    const body = state.requests.at(-1);
    const resumed = body.messages.at(-1)?.role === 'assistant';
    const searching = state.search && body.tools?.some((tool) => tool.name === 'web_search') && !resumed;
    let index = 0;
    if (searching) {
      const id = 'srvtoolu_test';
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'server_tool_use', id, name: 'web_search', input: {} } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query: state.search.query }) } });
      send('content_block_stop', { type: 'content_block_stop', index });
      index++;
      send('content_block_start', {
        type: 'content_block_start', index,
        content_block: {
          type: 'web_search_tool_result', tool_use_id: id,
          content: [{ type: 'web_search_result', url: state.search.url, title: state.search.title, encrypted_content: 'x', page_age: null }],
        },
      });
      send('content_block_stop', { type: 'content_block_stop', index });
      index++;
    }

    const paused = searching && state.pauseAfterSearch;
    if (!paused) {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '', ...(state.search ? { citations: [] } : {}) } });
      for (const text of state.text) {
        send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
      }
      if (state.search) {
        send('content_block_delta', {
          type: 'content_block_delta', index,
          delta: {
            type: 'citations_delta',
            citation: { type: 'web_search_result_location', url: state.search.url, title: state.search.title, cited_text: 'cited', encrypted_index: 'x' },
          },
        });
      }
      send('content_block_stop', { type: 'content_block_stop', index });
    }
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: paused ? 'pause_turn' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: state.outputTokens, ...(searching ? { server_tool_use: { web_search_requests: 1 } } : {}) },
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
