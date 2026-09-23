import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assertModule from 'node:assert';
import { after, before, beforeEach, describe, test } from 'node:test';
import { resetRuns } from '../../src/editing/commands.js';
import { parseNdjson } from '../../src/lib/ollama.js';
import { resetConversations } from '../../src/routing/conversation.js';
import { resetWarmState } from '../../src/routing/warm.js';
import { startFakeOllama } from '../fakeOllama.js';
import { ensureCentroids, registeredSession, startServer } from '../helpers.js';

const realOllama = process.env.OLLAMA_URL || 'http://localhost:11434';
const PROJECT = 'hmb/runnable';

describe('approved script runs', () => {
  let server;
  let ollama;
  let api;
  let workdir;

  async function ask(query) {
    const response = await api.raw('POST', '/api/chat', { query, project: PROJECT });
    const lines = [];
    for await (const line of parseNdjson(response.body)) lines.push(line);
    return lines;
  }

  before(async () => {
    ollama = await startFakeOllama({ embedUrl: realOllama });
    process.env.OLLAMA_URL = ollama.url;
    server = await startServer();
    await ensureCentroids(server.pool);
    api = await registeredSession(server.base);

    // A real working copy with a real, fast script.
    workdir = await mkdtemp(join(tmpdir(), 'scope-run-'));
    await writeFile(
      join(workdir, 'package.json'),
      JSON.stringify({
        name: 'runnable',
        scripts: {
          hello: "node -e \"process.stdout.write('colonies ok')\"",
          boom: 'node -e "process.exit(3)"',
        },
      })
    );

    await api('POST', '/api/nodes', {
      type: 'file',
      content: 'package.json\n\nthe runnable fixture project with a hello script',
      project: PROJECT,
      privacy: 'cloud',
    });
  });

  beforeEach(() => {
    resetRuns();
    resetConversations();
    resetWarmState();
    Object.assign(ollama.state, { chatRequests: [], pauseAfterFirstMs: 0, failAfterFirst: null });
  });

  after(async () => {
    process.env.OLLAMA_URL = realOllama;
    await server.close();
    await ollama.close();
  });

  async function bind(path) {
    return api('PUT', '/api/projects/settings', { project: PROJECT, localPath: path });
  }

  test('without a working copy there is nowhere to run', async () => {
    await bind(null);
    ollama.state.tokens = ['Run the tests: ', '<run>hello</run>'];
    const runs = (await ask('run the hello script')).find((line) => line.type === 'runs');
    assert.equal(runs.runs[0].state, 'unbound');
    assert.equal(runs.runs[0].cwd, null);
  });

  test('binding a working copy reports the scripts it declares', async () => {
    const { status, data } = await bind(workdir);
    assert.equal(status, 200);
    assert.equal(data.localPath, workdir);
    assert.deepEqual(data.scripts.sort(), ['boom', 'hello']);

    assert.equal((await bind('relative/path')).status, 400);
    assert.equal((await bind('/definitely/not/here')).status, 400);
    assert.equal((await bind(join(workdir, 'package.json'))).status, 400, 'a file is not a working copy');
  });

  test('a proposed script runs only when approved, and its output comes back', async () => {
    await bind(workdir);
    ollama.state.tokens = ['<run>hello</run>'];
    const proposal = (await ask('run the hello script please')).find((line) => line.type === 'runs').runs[0];
    assert.equal(proposal.state, 'proposed');
    assert.equal(proposal.command, 'npm run hello');
    assert.equal(proposal.cwd, workdir);
    assert.equal(proposal.output, null, 'nothing ran on its own');

    const { data } = await api('POST', `/api/runs/${proposal.id}/approve`, {});
    assert.equal(data.run.state, 'succeeded');
    assert.equal(data.run.exitCode, 0);
    assert.match(data.run.output, /colonies ok/);
    assert.ok(data.run.durationMs >= 0);

    assert.equal((await api('POST', `/api/runs/${proposal.id}/approve`, {})).status, 409);
  });

  test('a failing script reports its exit code rather than pretending', async () => {
    await bind(workdir);
    ollama.state.tokens = ['<run>boom</run>'];
    const proposal = (await ask('run the boom script')).find((line) => line.type === 'runs').runs[0];
    const { data } = await api('POST', `/api/runs/${proposal.id}/approve`, {});
    assert.equal(data.run.state, 'failed');
    assert.equal(data.run.exitCode, 3);
  });

  test('a script the project does not declare cannot be approved', async () => {
    await bind(workdir);
    ollama.state.tokens = ['<run>deploy</run>'];
    const proposal = (await ask('run the deploy script')).find((line) => line.type === 'runs').runs[0];
    assert.equal(proposal.state, 'undeclared');
    assert.equal((await api('POST', `/api/runs/${proposal.id}/approve`, {})).status, 409);
  });

  test('rejecting leaves it unrun, and runs belong to their owner', async () => {
    await bind(workdir);
    ollama.state.tokens = ['<run>hello</run>'];
    const proposal = (await ask('run hello for me')).find((line) => line.type === 'runs').runs[0];

    const rejected = await api('POST', `/api/runs/${proposal.id}/reject`, {});
    assert.equal(rejected.data.run.state, 'rejected');
    assert.equal((await api('POST', `/api/runs/${proposal.id}/approve`, {})).status, 409);

    const stranger = await registeredSession(server.base);
    assert.equal((await stranger('GET', '/api/runs')).data.runs.length, 0);
    assert.equal((await stranger('POST', `/api/runs/${proposal.id}/approve`, {})).status, 404);
    assertModule.ok(true);
  });
});
