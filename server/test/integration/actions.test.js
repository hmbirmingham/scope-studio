import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { resetActions } from '../../src/editing/actions.js';
import { parseNdjson } from '../../src/lib/ollama.js';
import { resetConversations } from '../../src/routing/conversation.js';
import { resetWarmState } from '../../src/routing/warm.js';
import { startFakeOllama } from '../fakeOllama.js';
import { ensureCentroids, registeredSession, startServer } from '../helpers.js';

const realOllama = process.env.OLLAMA_URL || 'http://localhost:11434';
const onMac = process.platform === 'darwin';

describe('screen actions', { skip: onMac ? false : 'actions open things only on macOS' }, () => {
  let server;
  let fake;
  let api;
  let other;
  let opened;

  const ask = async (query, tokens) => {
    fake.state.tokens = tokens;
    const response = await api.raw('POST', '/api/chat', { query, project: 'hmb/plates' });
    const lines = [];
    for await (const line of parseNdjson(response.body)) lines.push(line);
    return lines;
  };

  before(async () => {
    fake = await startFakeOllama({ embedUrl: realOllama });
    process.env.OLLAMA_URL = fake.url;
    server = await startServer();
    // Every approval in this suite goes to this recorder, never to the real `open`.
    server.app.locals.openRunner = (file, args, options, done) => {
      opened.push({ file, args });
      done(null, '', '');
    };
    await ensureCentroids(server.pool);
    api = await registeredSession(server.base);
    other = await registeredSession(server.base);

    await api('POST', '/api/nodes', {
      type: 'file',
      content: 'src/quantify.py\n\ndef quantify_colonies(image):\n    """Returns colony count and mean area."""',
      project: 'hmb/plates',
      privacy: 'cloud',
    });
    const root = await mkdtemp(join(tmpdir(), 'scope-plates-'));
    await writeFile(join(root, 'quantify.py'), 'def quantify_colonies(image):\n    pass\n');
    const saved = await api('PUT', '/api/projects/settings', { project: 'hmb/plates', localPath: root });
    assert.equal(saved.status, 200);
  });

  beforeEach(() => {
    opened = [];
    resetActions();
    resetConversations();
    resetWarmState();
  });

  after(async () => {
    process.env.OLLAMA_URL = realOllama;
    await server.close();
    await fake.close();
  });

  test('actions in an answer are held for approval, and approving opens exactly that', async () => {
    const lines = await ask('open the quantify file and search for watershed segmentation', [
      'Opening both. ',
      '<open kind="file">quantify.py</open>\n',
      '<open kind="search">watershed segmentation</open>',
    ]);
    const line = lines.find((l) => l.type === 'actions');
    assert.ok(line, 'an actions line is streamed');
    assert.deepEqual(line.actions.map((a) => [a.kind, a.state]), [['file', 'proposed'], ['search', 'proposed']]);
    assert.equal(opened.length, 0, 'nothing opens before approval');

    const [file, search] = line.actions;
    const approved = await api('POST', `/api/actions/${search.id}/approve`, {});
    assert.equal(approved.status, 200);
    assert.equal(approved.data.action.state, 'opened');
    assert.deepEqual(opened, [{ file: 'open', args: ['-u', 'https://duckduckgo.com/?q=watershed%20segmentation'] }]);

    const again = await api('POST', `/api/actions/${search.id}/approve`, {});
    assert.equal(again.status, 409, 'an action opens once');

    assert.equal((await api('POST', `/api/actions/${file.id}/reject`, {})).data.action.state, 'rejected');
    assert.equal((await api('POST', `/api/actions/${file.id}/approve`, {})).status, 409, 'a discarded action cannot be approved');
    assert.equal(opened.length, 1);
  });

  test('a refused action arrives refused and cannot be approved', async () => {
    const lines = await ask('open a terminal', ['<open kind="app">Terminal</open>']);
    const [action] = lines.find((l) => l.type === 'actions').actions;
    assert.equal(action.state, 'refused');
    assert.match(action.problem, /can run commands/);
    assert.equal((await api('POST', `/api/actions/${action.id}/approve`, {})).status, 409);
    assert.equal(opened.length, 0);
  });

  test("another user can neither see nor approve someone's action", async () => {
    const lines = await ask('search for pgvector', ['<open kind="search">pgvector</open>']);
    const [action] = lines.find((l) => l.type === 'actions').actions;
    assert.equal((await other('POST', `/api/actions/${action.id}/approve`, {})).status, 404);
    assert.equal((await other('GET', '/api/actions')).data.actions.length, 0);
    assert.equal(opened.length, 0);
  });

  test('an answer without actions streams no actions line', async () => {
    const lines = await ask('what does quantify_colonies return', ['Colony count and mean area.']);
    assert.ok(!lines.some((l) => l.type === 'actions'));
  });
});
