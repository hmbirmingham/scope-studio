import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { resetRuns } from '../../src/editing/commands.js';
import { localChatModel, parseNdjson } from '../../src/lib/ollama.js';
import { resetConversations } from '../../src/routing/conversation.js';
import { resetWarmState } from '../../src/routing/warm.js';
import { startFakeAnthropic } from '../fakeAnthropic.js';
import { linkUser, meFor, startFakeControl } from '../fakeControl.js';
import { deadUrl, startFakeOllama } from '../fakeOllama.js';
import { registeredSession, startServer } from '../helpers.js';

const realOllama = process.env.OLLAMA_URL || 'http://localhost:11434';
const KEY = 'sk-ant-test-not-a-real-key';
const PROJECT = 'hmb/rig';
const SECRET = 'GEARBOX-SECRET-TOLERANCES';
const GEARBOX_TEXT = `The gearbox housing is machined steel. ${SECRET}: bore 42.007 mm.`;

// An approved script's output is appended to the conversation so the next
// question can be about it. A script runs as the user, on the user's machine,
// and can print any file there, including the source of a node marked private.
// That output must never reach a cloud request, whatever the route.
describe('script output in a conversation', () => {
  let server;
  let ollama;
  let anthropic;
  let control;
  let api;
  let workdir;

  const chat = (body) =>
    api.raw('POST', '/api/chat', { project: PROJECT, ...body }, {
      headers: { 'Content-Type': 'application/json', 'x-anthropic-api-key': KEY },
    });

  async function readLines(response) {
    const lines = [];
    for await (const line of parseNdjson(response.body)) lines.push(line);
    return lines;
  }

  const sentToCloud = () => JSON.stringify(anthropic.state.requests);

  // One turn that proposes a script, then the user approves it. Returns the
  // conversation the run's output was added to.
  async function runInConversation(body, script) {
    const lines = await readLines(await chat(body));
    const [context] = lines;
    assert.equal(lines.at(-1).type, 'done');
    const proposal = lines.find((line) => line.type === 'runs')?.runs[0];
    assert.ok(proposal, 'the answer proposed a run');
    assert.equal(proposal.command, `npm run ${script}`);
    const { data } = await api('POST', `/api/runs/${proposal.id}/approve`, {});
    assert.equal(data.run.state, 'succeeded');
    return { context, run: data.run };
  }

  async function addNode(content, privacy) {
    return (await api('POST', '/api/nodes', { type: 'file', content, project: PROJECT, privacy })).data.id;
  }

  before(async () => {
    // Lexical-only retrieval, so which node a question reads is decided by its
    // words: every question here names the pump and never the gearbox.
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

    // The project's working copy: the private node's file is on disk there,
    // and `show` prints it, the way a test runner or a cat-like script would.
    workdir = await mkdtemp(join(tmpdir(), 'scope-run-output-'));
    await mkdir(join(workdir, 'docs'));
    await writeFile(join(workdir, 'docs', 'gearbox.md'), GEARBOX_TEXT);
    await writeFile(
      join(workdir, 'package.json'),
      JSON.stringify({
        name: 'rig',
        scripts: {
          show: "node -e \"process.stdout.write(require('fs').readFileSync('docs/gearbox.md', 'utf8'))\"",
          hello: "node -e \"process.stdout.write('PUMP-RUN-OK')\"",
        },
      })
    );
    assert.equal((await api('PUT', '/api/projects/settings', { project: PROJECT, localPath: workdir })).status, 200);
  });

  beforeEach(async () => {
    resetRuns();
    resetConversations();
    resetWarmState();
    Object.assign(anthropic.state, { requests: [], authHeaders: [], text: ['Cloud ', 'answer.'], status: 200, outputTokens: 40 });
    Object.assign(ollama.state, { chatRequests: [], tokens: ['Local ', 'answer.'], models: ['nomic-embed-text:latest', localChatModel()] });
    await server.pool.query('DELETE FROM nodes');
    await addNode('docs/pump.md\n\nThe pump impeller is cast bronze and spins at 3000 rpm.', 'cloud');
  });

  after(async () => {
    process.env.OLLAMA_URL = realOllama;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CONTROL_URL;
    await server.close();
    await control.close();
    await ollama.close();
    await anthropic.close();
    await rm(workdir, { recursive: true, force: true });
  });

  test("a cloud follow-up never resends a run's output that printed a private node's text", async () => {
    const gearbox = await addNode(`docs/gearbox.md\n\n${GEARBOX_TEXT}`, 'local');
    anthropic.state.text = ['Showing it: ', '<run>show</run>'];
    const { context, run } = await runInConversation({ query: 'what rpm does the pump impeller spin at', tier: 'cloud_frontier' }, 'show');
    assert.equal(context.routing.decision, 'cloud');
    assert.ok(!context.nodes.some((node) => node.id === gearbox), 'the first turn did not read the private node');
    assert.match(run.output, new RegExp(SECRET), "the run printed the private node's text");
    assert.ok(!sentToCloud().includes(SECRET), 'nothing private went to the cloud before the run');

    anthropic.state.text = ['Cloud ', 'answer.'];
    const lines = await readLines(await chat({ query: 'and the pump impeller rpm again?', tier: 'cloud_frontier', conversationId: context.conversationId }));
    const [followUp] = lines;
    assert.equal(lines.at(-1).type, 'done');
    assert.equal(followUp.routing.decision, 'cloud');
    assert.equal(followUp.routing.contextReused, true, 'the follow-up really does continue the conversation');
    assert.equal(anthropic.state.requests.length, 2);
    assert.ok(!sentToCloud().includes(SECRET), "the run's output did not go to the cloud");
    assert.equal(followUp.routing.runOutput, 'withheld', 'the routing says the output stayed on this machine');
    assert.match(JSON.stringify(anthropic.state.requests[1].messages), /withheld/, 'the model is told output was kept back, not left guessing');
  });

  test('output is withheld from the cloud even when the project holds no private nodes', async () => {
    // No node is private, but a script can print any file on the machine,
    // including another project's private source, so the output stays local.
    anthropic.state.text = ['<run>hello</run>'];
    const { context, run } = await runInConversation({ query: 'run hello for the pump impeller', tier: 'cloud_frontier' }, 'hello');
    assert.equal(run.output, 'PUMP-RUN-OK');

    anthropic.state.text = ['Cloud ', 'answer.'];
    const second = await readLines(await chat({ query: 'what did that pump impeller run print', tier: 'cloud_frontier', conversationId: context.conversationId }));
    assert.equal(second[0].routing.contextReused, true);
    assert.equal(second[0].routing.runOutput, 'withheld');
    const third = await readLines(await chat({ query: 'and the pump impeller rpm again?', tier: 'cloud_frontier', conversationId: context.conversationId }));
    assert.equal(third[0].routing.contextReused, true);
    assert.ok(!sentToCloud().includes('PUMP-RUN-OK'), 'no cloud turn carried the output');

    // The withheld stand-in is the same every turn, so the cloud cache prefix
    // still holds from one follow-up to the next.
    const [, secondSent, thirdSent] = anthropic.state.requests.map((request) => request.messages);
    assert.deepEqual(thirdSent.slice(0, secondSent.length - 1), secondSent.slice(0, -1));
  });

  test('a local follow-up still sees the output, which never leaves the machine there', async () => {
    await addNode(`docs/gearbox.md\n\n${GEARBOX_TEXT}`, 'local');
    ollama.state.tokens = ['<run>show</run>'];
    const { context } = await runInConversation({ query: 'what rpm does the pump impeller spin at' }, 'show');
    assert.equal(context.routing.decision, 'local');

    ollama.state.tokens = ['Local ', 'answer.'];
    const lines = await readLines(await chat({ query: 'and the pump impeller rpm again?', conversationId: context.conversationId }));
    const [followUp] = lines;
    assert.equal(followUp.routing.decision, 'local');
    assert.equal(followUp.routing.contextReused, true);
    assert.equal(followUp.routing.runOutput, 'included');
    assert.ok(JSON.stringify(ollama.state.chatRequests.at(-1).messages).includes(SECRET), 'the local model read the output');
    assert.equal(anthropic.state.requests.length, 0, 'nothing went to the cloud');
  });
});
