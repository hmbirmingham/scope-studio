import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { resetProposals } from '../../src/editing/proposals.js';
import { parseNdjson } from '../../src/lib/ollama.js';
import githubPlugin from '../../src/plugins/github/index.js';
import { resetConversations } from '../../src/routing/conversation.js';
import { resetWarmState } from '../../src/routing/warm.js';
import { startFakeOllama } from '../fakeOllama.js';
import { ensureCentroids, registeredSession, startServer } from '../helpers.js';

const realOllama = process.env.OLLAMA_URL || 'http://localhost:11434';
const FILE = 'src/quantify.py';
const ORIGINAL = 'def quantify_colonies(image):\n    return count\n';

// A GitHub that can be written to, and records exactly what was written.
function fakeWritableGitHub(state) {
  return {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: 'main' } }),
        getContent: async () => ({
          data: { content: Buffer.from(state.content).toString('base64'), encoding: 'base64', sha: 'file-sha' },
        }),
        createOrUpdateFileContents: async ({ path, branch, message, content }) => {
          state.writes.push({ path, branch, message, content: Buffer.from(content, 'base64').toString('utf8') });
          return { data: {} };
        },
      },
      git: {
        getRef: async () => ({ data: { object: { sha: 'base-sha' } } }),
        createRef: async ({ ref }) => {
          state.refs.push(ref);
          return { data: {} };
        },
      },
      pulls: {
        create: async ({ head, base }) => {
          state.pulls.push({ head, base });
          return { data: { html_url: 'https://github.com/hmb/plates/pull/7', number: 7 } };
        },
      },
    },
  };
}

describe('proposed edits', () => {
  let server;
  let ollama;
  let api;
  let github;
  const realCreateClient = githubPlugin.createClient;

  const editBlock = (search, replace) =>
    `<edit path="${FILE}">\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n</edit>`;

  async function ask(query) {
    const response = await api.raw('POST', '/api/chat', { query });
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
    await api('POST', '/api/nodes', {
      type: 'file',
      content: `${FILE}\n\n${ORIGINAL}`,
      project: 'hmb/plates',
      privacy: 'cloud',
    });
    await server.pool.query(
      `UPDATE session SET sess = jsonb_set(sess::jsonb, '{githubToken}', '"test-token"')::json`
    );
  });

  beforeEach(() => {
    resetProposals();
    resetConversations();
    resetWarmState();
    github = { content: ORIGINAL, writes: [], refs: [], pulls: [] };
    githubPlugin.createClient = () => fakeWritableGitHub(github);
    Object.assign(ollama.state, { chatRequests: [], pauseAfterFirstMs: 0, failAfterFirst: null });
  });

  after(async () => {
    githubPlugin.createClient = realCreateClient;
    process.env.OLLAMA_URL = realOllama;
    await server.close();
    await ollama.close();
  });

  test('an answer containing an edit proposes it, and nothing is written yet', async () => {
    ollama.state.tokens = ['Renaming the return. ', editBlock('    return count', '    return count, areas')];
    const lines = await ask('rename the return value in quantify');

    const edits = lines.find((line) => line.type === 'edits');
    assert.ok(edits, 'the stream announces the proposal');
    assert.equal(edits.edits.length, 1);
    assert.equal(edits.edits[0].path, FILE);
    assert.equal(edits.edits[0].project, 'hmb/plates', 'the retrieved node tied the path to its repository');
    assert.equal(edits.edits[0].state, 'proposed');
    assert.deepEqual(github.writes, [], 'nothing is written before approval');
    assert.deepEqual(github.pulls, []);

    const listed = (await api('GET', '/api/edits')).data.edits;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, edits.edits[0].id);
  });

  test('approving opens a pull request on a branch, never the default branch', async () => {
    ollama.state.tokens = [editBlock('    return count', '    return count, areas')];
    const [, ...rest] = await ask('return the areas too');
    const { id } = rest.find((line) => line.type === 'edits').edits[0];

    const { status, data } = await api('POST', `/api/edits/${id}/approve`, { message: 'Return areas as well' });
    assert.equal(status, 200);
    assert.equal(data.edit.state, 'applied');
    assert.match(data.edit.appliedTo, /pull\/7$/);

    assert.equal(github.writes.length, 1);
    assert.match(github.writes[0].branch, /^scope-studio\//);
    assert.equal(github.writes[0].message, 'Return areas as well');
    assert.equal(
      github.writes[0].content,
      'def quantify_colonies(image):\n    return count, areas\n',
      'the change is applied to the real file, not the stored chunk'
    );
    assert.deepEqual(github.refs, [`refs/heads/${github.writes[0].branch}`]);
    assert.deepEqual(github.pulls, [{ head: github.writes[0].branch, base: 'main' }]);

    const again = await api('POST', `/api/edits/${id}/approve`, {});
    assert.equal(again.status, 409, 'an applied edit cannot be applied twice');
  });

  test('an edit against a file that has moved on fails loudly and writes nothing', async () => {
    ollama.state.tokens = [editBlock('    return count', '    return count, areas')];
    const lines = await ask('return the areas as well please');
    const { id } = lines.find((line) => line.type === 'edits').edits[0];

    github.content = 'def quantify_colonies(image):\n    return {"count": count}\n';
    const { status, data } = await api('POST', `/api/edits/${id}/approve`, {});
    assert.equal(status, 422);
    assert.match(data.error, /no longer in|changed since/);
    assert.equal(data.edit.state, 'failed');
    assert.deepEqual(github.writes, []);
  });

  test('rejecting leaves the repository untouched', async () => {
    ollama.state.tokens = [editBlock('    return count', '    return nothing')];
    const lines = await ask('make it return nothing');
    const { id } = lines.find((line) => line.type === 'edits').edits[0];

    const { data } = await api('POST', `/api/edits/${id}/reject`, {});
    assert.equal(data.edit.state, 'rejected');
    assert.equal((await api('POST', `/api/edits/${id}/approve`, {})).status, 409);
    assert.deepEqual(github.writes, []);
  });

  test('an abbreviated edit is flagged before approval, not after', async () => {
    ollama.state.tokens = [editBlock('def quantify_colonies(image):\n    # ... (rest of the function)', '    return count, areas')];
    const lines = await ask('add a docstring to quantify colonies');
    const edit = lines.find((line) => line.type === 'edits').edits[0];
    assert.equal(edit.state, 'unverified');
    assert.match(edit.note, /abbreviated/);
    assert.equal((await api('POST', `/api/edits/${edit.id}/approve`, {})).status, 409);
    assert.deepEqual(github.writes, []);
  });

  test('an edit to a file nobody retrieved is unresolved, not applied to a guess', async () => {
    ollama.state.tokens = [
      `<edit path="src/somewhere_else.py">\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n</edit>`,
    ];
    const lines = await ask('change the other file in quantify project');
    const edit = lines.find((line) => line.type === 'edits').edits[0];
    assert.equal(edit.state, 'unresolved');
    assert.equal(edit.project, null);
    assert.equal((await api('POST', `/api/edits/${edit.id}/approve`, {})).status, 409);
  });

  test("edits belong to their owner", async () => {
    ollama.state.tokens = [editBlock('    return count', '    return count, areas')];
    const lines = await ask('return areas from quantify colonies');
    const { id } = lines.find((line) => line.type === 'edits').edits[0];

    const stranger = await registeredSession(server.base);
    assert.equal((await stranger('GET', '/api/edits')).data.edits.length, 0);
    assert.equal((await stranger('POST', `/api/edits/${id}/approve`, {})).status, 404);
    await sleep(10);
  });
});
