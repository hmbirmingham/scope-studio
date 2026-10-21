import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startJob } from '../../src/plugins/jobs.js';
import { createPythonRunner } from '../../src/plugins/physics/python.js';
import { registeredSession, session, startServer } from '../helpers.js';
import { removeTempDirs, useDataDir } from './workspaceSandboxFixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, '../fixtures/physics', `${name}.json`), 'utf8'));
const problems = ['pendulum-period', 'rc-charging'].map(fixture);

let server;
let data;

before(async () => {
  data = useDataDir();
  server = await startServer();
});
after(async () => {
  await server.close();
  data.restore();
  removeTempDirs();
});

async function settle(api, id) {
  for (let i = 0; i < 200; i += 1) {
    const { data: job } = await api('GET', `/api/plugins/physics/jobs/${id}`);
    if (job.state !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the ingest job never finished');
}

describe('/api/plugins/physics', () => {
  test('needs a signed-in user', async () => {
    const anonymous = session(server.base);
    assert.equal((await anonymous('GET', '/api/plugins/physics/status')).status, 401);
    assert.equal((await anonymous('POST', '/api/plugins/physics/ingest', { project: 'p', problems })).status, 401);
  });

  test('reports whether the sandboxed toolchain is usable here', async () => {
    const api = await registeredSession(server.base);
    const { status, data: body } = await api('GET', '/api/plugins/physics/status');
    assert.equal(status, 200);
    const expected = await createPythonRunner().availability();
    assert.equal(body.available, expected.available);
    assert.equal(body.reason, expected.reason);
    if (body.available) assert.ok(body.versions.scipy && body.versions.pint && body.versions.numpy);
  });

  test('ingests problems as a background job, once per id, and keeps answers out', async () => {
    const api = await registeredSession(server.base);
    const { data: { userId } } = await api('GET', '/api/auth/session');
    const started = await api('POST', '/api/plugins/physics/ingest', { project: 'mechanics', problems });
    assert.equal(started.status, 202);
    assert.equal(started.data.kind, 'physics.ingest');
    const job = await settle(api, started.data.id);
    assert.equal(job.state, 'done', job.error);
    assert.deepEqual(job.summary, { project: 'mechanics', problems: 2 });

    const again = await settle(api, (await api('POST', '/api/plugins/physics/ingest', { project: 'mechanics', problems })).data.id);
    assert.equal(again.state, 'done');
    const { rows } = await server.pool.query("SELECT type, source, privacy, external_id, content FROM nodes WHERE owner_id = $1 AND source = 'physics' ORDER BY external_id", [userId]);
    assert.deepEqual(rows.map((row) => [row.type, row.privacy, row.external_id]), [
      ['spec', 'local', 'problem:pendulum-period'],
      ['spec', 'local', 'problem:rc-charging'],
    ]);
    assert.ok(rows.every((row) => !row.content.includes(String(problems[0].answer.value).slice(0, 6))));
  });

  test('refuses a bad body, a concurrent ingest and other people’s jobs', async () => {
    const api = await registeredSession(server.base);
    const bad = await api('POST', '/api/plugins/physics/ingest', { project: 'mechanics', problems: [{ id: 'x' }] });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error, 'invalid_input');
    assert.match(bad.data.message, /statement/);
    assert.equal((await api('POST', '/api/plugins/physics/ingest', { problems })).status, 400);

    const { data: { userId } } = await api('GET', '/api/auth/session');
    let release;
    const blocker = startJob(userId, 'physics.ingest', () => new Promise((resolve) => { release = resolve; }));
    const busy = await api('POST', '/api/plugins/physics/ingest', { project: 'mechanics', problems });
    assert.equal(busy.status, 409);
    assert.equal(busy.data.job.id, blocker.id);
    release({});

    const other = await registeredSession(server.base);
    assert.equal((await other('GET', `/api/plugins/physics/jobs/${blocker.id}`)).status, 404);
    // A GitHub job is not reachable through the physics routes either.
    const github = startJob(userId, 'github.ingest', async () => ({}));
    assert.equal((await api('GET', `/api/plugins/physics/jobs/${github.id}`)).status, 404);
  });
});
