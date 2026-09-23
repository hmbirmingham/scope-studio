import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import githubPlugin from '../../src/plugins/github/index.js';
import { resetJobs } from '../../src/plugins/jobs.js';
import { fakeOctokit, fakeRepo } from '../fakeGitHub.js';
import { registeredSession, startServer } from '../helpers.js';

const tree = (name) => [{ type: 'blob', path: 'README.md', sha: `${name}-readme`, size: 40 }];

function stateFor(repos) {
  return {
    repos,
    trees: Object.fromEntries(repos.map((repo) => [repo.name, tree(repo.name)])),
    blobs: Object.fromEntries(repos.map((repo) => [`${repo.name}-readme`, `# ${repo.name}\n\nnotes about ${repo.name}`])),
    treesFetched: [],
  };
}

describe('github repository picker and ingest jobs', () => {
  let server;
  let api;
  let state;
  const realCreateClient = githubPlugin.createClient;

  async function connect() {
    // The picker and job routes need a connected session; the OAuth exchange
    // itself is covered by the auth tests.
    await api('POST', '/api/nodes', { type: 'repo', content: 'seed', project: 'hmb/already-here' });
    await server.pool.query(
      `UPDATE session SET sess = jsonb_set(sess::jsonb, '{githubToken}', '"test-token"')::json`
    );
  }

  async function poll(id) {
    for (let i = 0; i < 100; i++) {
      const { data } = await api('GET', `/api/plugins/github/jobs/${id}`);
      if (data.state !== 'running') return data;
      await sleep(20);
    }
    throw new Error('job never finished');
  }

  before(async () => {
    server = await startServer();
    api = await registeredSession(server.base);
    await connect();
  });

  beforeEach(() => {
    resetJobs();
    state = stateFor([fakeRepo(1, 'plates'), fakeRepo(2, 'firmware', true), fakeRepo(3, 'already-here')]);
    githubPlugin.createClient = () => fakeOctokit(state);
  });

  after(async () => {
    githubPlugin.createClient = realCreateClient;
    await server.close();
  });

  test('lists every repository, flagging the ones already on the map', async () => {
    const { status, data } = await api('GET', '/api/plugins/github/repos');
    assert.equal(status, 200);
    assert.deepEqual(
      data.repos.map((entry) => [entry.fullName, entry.privacy, entry.ingested]),
      [
        ['hmb/plates', 'cloud', false],
        ['hmb/firmware', 'local', false],
        ['hmb/already-here', 'cloud', true],
      ]
    );
    assert.ok(data.repos.find((entry) => entry.fullName === 'hmb/already-here').nodes > 0);
  });

  test('ingest returns a job immediately and reports progress until it finishes', async () => {
    state.treeDelayMs = 40;
    const started = performance.now();
    const { status, data } = await api('POST', '/api/plugins/github/ingest', { repos: ['hmb/plates'] });
    assert.equal(status, 202);
    assert.equal(data.state, 'running');
    assert.ok(performance.now() - started < 1000, 'the request does not wait for the ingest');

    const finished = await poll(data.id);
    assert.equal(finished.state, 'done', finished.error ?? '');
    assert.equal(finished.summary.repos, 1, 'only the chosen repository was ingested');
    assert.ok(finished.summary.chunks > 0);
    assert.deepEqual(state.treesFetched, ['plates']);
    assert.equal(finished.progress.reposDone, 1);
    assert.equal(finished.progress.reposTotal, 1);
    assert.ok(finished.finishedAt);
  });

  test('refuses a second ingest while one is running', async () => {
    state.treeDelayMs = 200;
    const first = await api('POST', '/api/plugins/github/ingest', {});
    const second = await api('POST', '/api/plugins/github/ingest', {});
    assert.equal(second.status, 409);
    assert.equal(second.data.job.id, first.data.id);
    await poll(first.data.id);
  });

  test('a failed ingest is reported on the job, not lost', async () => {
    state.failWith = 'GitHub said no';
    const { data } = await api('POST', '/api/plugins/github/ingest', {});
    const finished = await poll(data.id);
    assert.equal(finished.state, 'failed');
    assert.match(finished.error, /GitHub said no/);
  });

  test('a revoked GitHub token asks for a reconnect instead of showing an empty list', async () => {
    state.failWith = 'Bad credentials';
    state.failStatus = 401;
    const { status, data } = await api('GET', '/api/plugins/github/repos');
    assert.equal(status, 401);
    assert.match(data.error, /reconnect/i);
    assert.equal((await api('GET', '/api/plugins/github/status')).data.connected, false, 'the dead token is dropped');

    // Put the session back for the remaining tests.
    await server.pool.query(
      `UPDATE session SET sess = jsonb_set(sess::jsonb, '{githubToken}', '"test-token"')::json`
    );
  });

  test('validation, ownership, and connection', async () => {
    assert.equal((await api('POST', '/api/plugins/github/ingest', { repos: 'plates' })).status, 400);
    assert.equal((await api('GET', '/api/plugins/github/jobs/2b3f6b8e-0000-4000-8000-000000000000')).status, 404);

    const stranger = await registeredSession(server.base);
    assert.equal((await stranger('GET', '/api/plugins/github/repos')).status, 400, 'not connected');
  });
});
