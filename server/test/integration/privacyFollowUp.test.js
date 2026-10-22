import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { localChatModel, parseNdjson } from '../../src/lib/ollama.js';
import { resetConversations } from '../../src/routing/conversation.js';
import { resetWarmState } from '../../src/routing/warm.js';
import { startFakeAnthropic } from '../fakeAnthropic.js';
import { linkUser, meFor, startFakeControl } from '../fakeControl.js';
import { deadUrl, startFakeOllama } from '../fakeOllama.js';
import { registeredSession, startServer } from '../helpers.js';

const realOllama = process.env.OLLAMA_URL || 'http://localhost:11434';
const KEY = 'sk-ant-test-not-a-real-key';
const SECRET = 'GEARBOX-SECRET-TOLERANCES';

// A conversation keeps the nodes its earlier turns read, and a follow-up that
// still overlaps them resends that context so the model's cache is reused.
// Those nodes were snapshots of the moment they were read: a node the user
// marks private between turns must not ride along on the next cloud request.
describe('a node made private mid-conversation', () => {
  let server;
  let ollama;
  let anthropic;
  let control;
  let api;
  let pump;
  let gearbox;

  const chat = (body) =>
    api.raw('POST', '/api/chat', body, { headers: { 'Content-Type': 'application/json', 'x-anthropic-api-key': KEY } });

  async function readLines(response) {
    const lines = [];
    for await (const line of parseNdjson(response.body)) lines.push(line);
    return lines;
  }

  // The first turn reads both nodes and goes to the cloud. The node then
  // becomes private through the same endpoint the app uses to edit a node.
  async function cloudTurnThenMarkPrivate() {
    const lines = await readLines(await chat({ query: 'how do the pump impeller and the gearbox housing fit together', tier: 'cloud_frontier' }));
    const [context] = lines;
    assert.equal(lines.at(-1).type, 'done');
    assert.equal(context.routing.decision, 'cloud');
    const read = context.nodes.map((node) => node.id);
    assert.ok(read.includes(pump) && read.includes(gearbox), 'the first turn read both nodes');
    assert.ok(JSON.stringify(anthropic.state.requests[0]).includes(SECRET), 'the gearbox text went to the cloud while it was public');

    const marked = await api('PATCH', `/api/nodes/${gearbox}`, { privacy: 'local' });
    assert.equal(marked.status, 200);
    assert.equal(marked.data.privacy, 'local');
    return context.conversationId;
  }

  before(async () => {
    // Lexical-only retrieval, so which node a question reads is decided by
    // its words: the follow-up names only the pump.
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
  });

  beforeEach(async () => {
    resetConversations();
    resetWarmState();
    Object.assign(anthropic.state, { requests: [], authHeaders: [], text: ['Cloud ', 'answer.'], status: 200, outputTokens: 40 });
    Object.assign(ollama.state, { chatRequests: [], tokens: ['Local ', 'answer.'], models: ['nomic-embed-text:latest', localChatModel()] });
    // Fresh nodes per test, both public to begin with.
    await server.pool.query('DELETE FROM nodes');
    const made = async (content) =>
      (await api('POST', '/api/nodes', { type: 'file', content, project: 'hmb/rig', privacy: 'cloud' })).data.id;
    pump = await made('docs/pump.md\n\nThe pump impeller is cast bronze and spins at 3000 rpm.');
    gearbox = await made(`docs/gearbox.md\n\nThe gearbox housing bolts to the pump flange. ${SECRET}: bore 42.007 mm.`);
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

  test('a cloud follow-up is answered locally instead of resending the now-private node', async () => {
    const conversationId = await cloudTurnThenMarkPrivate();

    const lines = await readLines(await chat({ query: 'what rpm does the pump impeller spin at', tier: 'cloud_frontier', conversationId }));
    const [context] = lines;
    assert.equal(lines.at(-1).type, 'done');
    assert.ok(!JSON.stringify(anthropic.state.requests.slice(1)).includes(SECRET), 'the private text was not resent to the cloud');
    assert.equal(anthropic.state.requests.length, 1, 'no second cloud request was made');
    assert.equal(context.routing.decision, 'local');
    assert.equal(context.routing.reason, 'privacy_flag');
    assert.equal(ollama.state.chatRequests.length, 1, 'the local model answered');
  });

  test('the follow-up is refused when the local model cannot answer it', async () => {
    const conversationId = await cloudTurnThenMarkPrivate();
    ollama.state.models = ['nomic-embed-text:latest'];

    const response = await chat({ query: 'what rpm does the pump impeller spin at', tier: 'cloud_frontier', conversationId });
    const body = response.headers.get('content-type')?.includes('ndjson') ? await readLines(response) : await response.json();
    assert.ok(!JSON.stringify(anthropic.state.requests.slice(1)).includes(SECRET), 'the private text was not resent to the cloud');
    assert.equal(response.status, 503);
    assert.equal(body.code, 'local_unavailable');
    assert.equal(body.routing.reason, 'privacy_flag');
    assert.equal(anthropic.state.requests.length, 1, 'nothing more went to the cloud');
    assert.equal(ollama.state.chatRequests.length, 0);
  });

  test('a web search follow-up, whose retrieval skips private nodes, is refused rather than resending one', async () => {
    const conversationId = await cloudTurnThenMarkPrivate();

    const response = await chat({ query: 'what rpm does the pump impeller spin at', webSearch: true, conversationId });
    const body = response.headers.get('content-type')?.includes('ndjson') ? await readLines(response) : await response.json();
    assert.ok(!JSON.stringify(anthropic.state.requests.slice(1)).includes(SECRET), 'the private text was not resent to the cloud');
    assert.equal(response.status, 409);
    assert.equal(body.code, 'web_search_private');
    assert.equal(anthropic.state.requests.length, 1, 'nothing more went to the cloud');
  });

  test('a prepared draft is not reused for the cloud once one of its nodes is private', async () => {
    const prepared = await api.raw(
      'POST',
      '/api/chat/prepare',
      { query: 'how do the pump impeller and the gearbox housing fit together', tier: 'cloud_frontier' },
      { headers: { 'Content-Type': 'application/json', 'x-anthropic-api-key': KEY } }
    );
    const draft = await prepared.json();
    assert.equal(draft.routing.decision, 'cloud');
    assert.ok(draft.nodes.some((node) => node.id === gearbox), 'the draft read the gearbox node');
    assert.equal((await api('PATCH', `/api/nodes/${gearbox}`, { privacy: 'local' })).status, 200);

    // The draft covers this question (it read the pump node), so it would be reused.
    const lines = await readLines(await chat({ query: 'what rpm does the pump impeller spin at', tier: 'cloud_frontier' }));
    const [context] = lines;
    assert.equal(lines.at(-1).type, 'done');
    assert.ok(!JSON.stringify(anthropic.state.requests).includes(SECRET), 'the private text never went to the cloud');
    assert.equal(anthropic.state.requests.length, 0, 'nothing went to the cloud');
    assert.equal(context.routing.decision, 'local');
    assert.equal(context.routing.reason, 'privacy_flag');
    assert.ok(!context.nodes.some((node) => node.id === gearbox && node.privacy !== 'local'), 'no stale public copy of the node is shown');
  });

  test('a follow-up still continues in the cloud when nothing it carries became private', async () => {
    const first = await readLines(await chat({ query: 'how do the pump impeller and the gearbox housing fit together', tier: 'cloud_frontier' }));
    const lines = await readLines(
      await chat({ query: 'what rpm does the pump impeller spin at', tier: 'cloud_frontier', conversationId: first[0].conversationId })
    );
    const [context] = lines;
    assert.equal(context.routing.decision, 'cloud');
    assert.equal(context.routing.contextReused, true, 'the fixture really does continue the conversation');
    assert.equal(anthropic.state.requests.length, 2);
  });

  test('a node deleted mid-conversation is not resent: the follow-up starts a fresh context', async () => {
    const first = await readLines(await chat({ query: 'how do the pump impeller and the gearbox housing fit together', tier: 'cloud_frontier' }));
    assert.equal((await api('DELETE', `/api/nodes/${gearbox}`)).status, 204);
    const lines = await readLines(
      await chat({ query: 'what rpm does the pump impeller spin at', tier: 'cloud_frontier', conversationId: first[0].conversationId })
    );
    const [context] = lines;
    assert.equal(context.routing.decision, 'cloud');
    assert.equal(context.routing.contextReused, false);
    assert.ok(!JSON.stringify(anthropic.state.requests[1]).includes(SECRET));
  });
});
