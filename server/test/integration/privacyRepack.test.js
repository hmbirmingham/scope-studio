import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { parseNdjson } from '../../src/lib/ollama.js';
import { resetConversations } from '../../src/routing/conversation.js';
import { resetWarmState } from '../../src/routing/warm.js';
import { startFakeAnthropic } from '../fakeAnthropic.js';
import { linkUser, meFor, startFakeControl } from '../fakeControl.js';
import { deadUrl, startFakeOllama } from '../fakeOllama.js';
import { registeredSession, startServer } from '../helpers.js';

const realOllama = process.env.OLLAMA_URL || 'http://localhost:11434';
const KEY = 'sk-ant-test-not-a-real-key';

// Auto decides on the local-sized pack (5 nodes) and, for a hard question,
// re-packs at the cloud budget (10 nodes). A private node ranked 6th is not in
// the first pack but is in the second; it must still never reach the cloud.
describe('privacy after a cloud re-pack', () => {
  let server;
  let ollama;
  let anthropic;
  let control;
  let api;
  const ids = [];

  const chat = (body) =>
    api.raw('POST', '/api/chat', body, { headers: { 'Content-Type': 'application/json', 'x-anthropic-api-key': KEY } });

  async function readLines(response) {
    const lines = [];
    for await (const line of parseNdjson(response.body)) lines.push(line);
    return lines;
  }

  before(async () => {
    // Embeddings are unavailable, so retrieval is lexical-only and the ranking
    // follows term frequency, which the test controls.
    ollama = await startFakeOllama({ embedUrl: await deadUrl() });
    anthropic = await startFakeAnthropic();
    control = await startFakeControl();
    process.env.OLLAMA_URL = ollama.url;
    process.env.CONTROL_URL = control.url;
    process.env.ANTHROPIC_BASE_URL = anthropic.url;
    server = await startServer();
    api = await registeredSession(server.base);
    const userId = (await api('GET', '/api/auth/session')).data.userId;
    const token = await linkUser(server.pool, userId, 'key_pro', { me: meFor('key_pro') });
    control.state.me.set(token, meFor('key_pro'));

    // n0 mentions the subject most, n7 least; n6 is private.
    for (let i = 0; i < 8; i++) {
      const mentions = Array.from({ length: 8 - i }, () => 'stepper driver tuning').join('; ');
      const { data } = await api('POST', '/api/nodes', {
        type: 'file',
        content: `notes/n${i}.md\n\nn${i}: ${mentions}.${i === 6 ? ' PRIVATE-CALIBRATION-TABLE' : ''}`,
        project: 'hmb/stage',
        privacy: i === 6 ? 'local' : 'cloud',
      });
      ids.push(data.id);
    }
  });

  beforeEach(() => {
    resetConversations();
    resetWarmState();
    Object.assign(anthropic.state, { requests: [], authHeaders: [], text: ['Cloud ', 'answer.'], status: 200, outputTokens: 40 });
    Object.assign(ollama.state, { chatRequests: [], tokens: ['Local ', 'answer.'] });
  });

  after(async () => {
    process.env.OLLAMA_URL = realOllama;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CONTROL_URL;
    await server.close();
    await control.close();
    await ollama.close();
    await anthropic.close();
  });

  test('a hard question whose cloud pack would reach a private node is answered locally', async () => {
    const lines = await readLines(await chat({ query: 'compare stepper driver tuning approaches' }));
    const [context] = lines;
    assert.equal(lines.at(-1).type, 'done');
    assert.equal(context.routing.difficulty, 'wording', 'the question is hard, so Auto wanted the cloud');
    assert.equal(context.routing.decision, 'local');
    assert.equal(context.routing.reason, 'privacy_flag');
    assert.equal(anthropic.state.requests.length, 0, 'nothing went to the cloud');
    const sent = JSON.stringify(anthropic.state.requests);
    assert.ok(!sent.includes('PRIVATE-CALIBRATION-TABLE'));
    assert.equal(ollama.state.chatRequests.length, 1);
  });

  test('the same hard question goes to the cloud once the node is no longer private', async () => {
    await server.pool.query("UPDATE nodes SET privacy = 'cloud' WHERE id = $1", [ids[6]]);
    try {
      const lines = await readLines(await chat({ query: 'compare stepper driver tuning approaches' }));
      const [context] = lines;
      assert.equal(context.routing.decision, 'cloud', 'the fixture really does route this question to the cloud');
      assert.equal(context.routing.reason, 'complexity');
      assert.ok(context.nodes.length > 5, 'the cloud pack is larger than the local one');
      assert.ok(context.nodes.some((node) => node.id === ids[6]), 'and it reaches the 6th-ranked node');
      assert.equal(anthropic.state.requests.length, 1);
    } finally {
      await server.pool.query("UPDATE nodes SET privacy = 'local' WHERE id = $1", [ids[6]]);
    }
  });
});
