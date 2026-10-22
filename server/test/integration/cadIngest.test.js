import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createCadQuery, defaultSandbox } from '../../src/plugins/cad/cadquery.js';
import { ingestCadProject } from '../../src/plugins/cad/ingest.js';
import { encodeBinaryStl } from '../../src/plugins/cad/stl.js';
import { resetJobs, startJob } from '../../src/plugins/jobs.js';
import { cadQueryForTests } from '../fixtures/cad/replay.js';
import { box } from '../fixtures/cad/shapes.js';
import { registeredSession, session, startServer } from '../helpers.js';
import { removeTempDirs, tempDir, useDataDir } from './workspaceSandboxFixtures.js';

// CAD ingest: a project's folder of STL and STEP files becomes part and
// assembly nodes with `contains` edges, as a background job, idempotently,
// without the network.

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'cad');
const fixture = (name) => readFileSync(join(FIXTURES, name));

describe('CAD ingest', () => {
  let server;
  let api;
  let ownerId;
  let data;
  let folder;
  let projects = 0;
  let project;

  async function waitForJob(id) {
    for (let i = 0; i < 400; i += 1) {
      const { data: job } = await api('GET', `/api/plugins/cad/jobs/${id}`);
      if (job.state !== 'running') return job;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the ingest job did not finish');
  }

  const cadNodes = async (name = project) =>
    (await server.pool.query("SELECT id, type, content, external_id, privacy FROM nodes WHERE owner_id = $1 AND source = 'cad' AND project = $2 ORDER BY external_id", [ownerId, name])).rows;

  before(async () => {
    server = await startServer();
    api = await registeredSession(server.base);
    ({ data: { userId: ownerId } } = await api('GET', '/api/auth/session'));
    data = useDataDir();
  });

  beforeEach(async () => {
    resetJobs();
    projects += 1;
    project = `cad-project-${projects}`;
    folder = tempDir('cad-ingest');
    writeFileSync(join(folder, 'cad.json'), JSON.stringify({ units: 'mm' }));
    writeFileSync(join(folder, 'cube.stl'), fixture('cube.stl'));
    mkdirSync(join(folder, 'parts'));
    writeFileSync(join(folder, 'parts', 'bracket.stl'), fixture('bracket.stl'));
    writeFileSync(join(folder, 'parts', 'assembly.step'), fixture('bracket-assembly.step'));
    // Not ingested: hidden folders, dependencies, links and other files.
    mkdirSync(join(folder, '.cache'));
    writeFileSync(join(folder, '.cache', 'old.stl'), fixture('cube.stl'));
    mkdirSync(join(folder, 'node_modules'));
    writeFileSync(join(folder, 'node_modules', 'dep.stl'), fixture('cube.stl'));
    const outside = tempDir('cad-outside');
    writeFileSync(join(outside, 'secret.stl'), fixture('cube.stl'));
    symlinkSync(join(outside, 'secret.stl'), join(folder, 'linked.stl'));
    writeFileSync(join(folder, 'notes.md'), '# notes\n');
    await server.pool.query('INSERT INTO project_settings (owner_id, project, local_path) VALUES ($1, $2, $3)', [ownerId, project, folder]);
  });

  after(async () => {
    resetJobs();
    data.restore();
    removeTempDirs();
    await server.close();
  });

  test('ingests parts and assemblies as local nodes, with contains edges weighted by quantity', async () => {
    const started = await api('POST', '/api/plugins/cad/ingest', { project });
    assert.equal(started.status, 202);
    assert.equal(started.data.kind, 'cad.ingest');
    const job = await waitForJob(started.data.id);
    assert.equal(job.state, 'done', job.error);
    assert.equal(job.summary.files, 3);
    assert.equal(job.summary.parts, 4);
    assert.equal(job.summary.assemblies, 1);
    assert.equal(job.summary.relationships, 2);
    assert.deepEqual(job.summary.skipped, []);

    const nodes = await cadNodes();
    assert.deepEqual(nodes.map((n) => [n.external_id, n.type]), [
      [`${project}|cube.stl`, 'part'],
      [`${project}|parts/assembly.step#ASM-1`, 'assembly'],
      [`${project}|parts/assembly.step#BLT-M4`, 'part'],
      [`${project}|parts/assembly.step#BRK-1`, 'part'],
      [`${project}|parts/bracket.stl`, 'part'],
    ]);
    assert.ok(nodes.every((n) => n.privacy === 'local'), 'local files stay on the machine');
    const cube = nodes.find((n) => n.external_id.endsWith('|cube.stl'));
    assert.match(cube.content, /Bounding box: 10 × 10 × 10 mm/);
    assert.match(cube.content, /Volume: 1000 mm³/);
    assert.match(cube.content, /watertight/);
    const assembly = nodes.find((n) => n.type === 'assembly');
    assert.match(assembly.content, /Contains: 1 × Bracket, 2 × M4 bolt/);

    const { rows: edges } = await server.pool.query(
      `SELECT t.external_id, r.weight FROM node_relationships r JOIN nodes t ON t.id = r.target_id
       WHERE r.source_id = $1 AND r.type = 'contains' ORDER BY t.external_id`,
      [assembly.id]
    );
    assert.deepEqual(edges.map((e) => [e.external_id, e.weight]), [[`${project}|parts/assembly.step#BLT-M4`, 2], [`${project}|parts/assembly.step#BRK-1`, 1]]);
  });

  test('ingesting again updates in place, removes what is gone and keeps what failed to read', async () => {
    await waitForJob((await api('POST', '/api/plugins/cad/ingest', { project })).data.id);
    const before = await cadNodes();

    writeFileSync(join(folder, 'cube.stl'), encodeBinaryStl(box(20)));
    rmSync(join(folder, 'parts', 'assembly.step'));
    writeFileSync(join(folder, 'parts', 'bracket.stl'), 'solid broken\nfacet normal 0 0 1\n');
    const job = await waitForJob((await api('POST', '/api/plugins/cad/ingest', { project })).data.id);
    assert.equal(job.state, 'done', job.error);
    assert.deepEqual(job.summary.skipped.map((s) => s.path), ['parts/bracket.stl']);
    assert.equal(job.summary.pruned, 3, 'the assembly file’s three products');

    const nodes = await cadNodes();
    const id = (list, rel) => list.find((n) => n.external_id === `${project}|${rel}`)?.id;
    assert.deepEqual(nodes.map((n) => n.external_id), [`${project}|cube.stl`, `${project}|parts/bracket.stl`]);
    assert.equal(id(nodes, 'cube.stl'), id(before, 'cube.stl'), 'the same node, updated');
    assert.match(nodes.find((n) => n.external_id === `${project}|cube.stl`).content, /20 × 20 × 20 mm/);
    assert.equal(id(nodes, 'parts/bracket.stl'), id(before, 'parts/bracket.stl'), 'an unreadable file keeps its node');
  });

  test('another project’s and another source’s nodes are never pruned', async () => {
    await server.pool.query("INSERT INTO nodes (owner_id, type, content, source, external_id, project) VALUES ($1, 'part', 'elsewhere', 'cad', 'gone.stl', 'other-project')", [ownerId]);
    await server.pool.query("INSERT INTO nodes (owner_id, type, content, source, external_id, project) VALUES ($1, 'repo', 'a repo', 'github', 'gone.stl', $2)", [ownerId, project]);
    await waitForJob((await api('POST', '/api/plugins/cad/ingest', { project })).data.id);
    const { rows } = await server.pool.query("SELECT source, project FROM nodes WHERE owner_id = $1 AND external_id = 'gone.stl' ORDER BY source", [ownerId]);
    assert.deepEqual(rows.map((r) => [r.source, r.project]), [['cad', 'other-project'], ['github', project]]);
  });

  test('a project can opt its parts into the cloud, and back to local', async () => {
    await waitForJob((await api('POST', '/api/plugins/cad/ingest', { project, privacy: 'cloud' })).data.id);
    assert.ok((await cadNodes()).every((n) => n.privacy === 'cloud'));
    await waitForJob((await api('POST', '/api/plugins/cad/ingest', { project })).data.id);
    assert.ok((await cadNodes()).every((n) => n.privacy === 'local'), 'local again, not left in the cloud');
  });

  test('two projects with the same file names keep separate nodes', async () => {
    const first = project;
    await waitForJob((await api('POST', '/api/plugins/cad/ingest', { project: first })).data.id);
    const second = `${first}-copy`;
    await server.pool.query('INSERT INTO project_settings (owner_id, project, local_path) VALUES ($1, $2, $3)', [ownerId, second, folder]);
    await waitForJob((await api('POST', '/api/plugins/cad/ingest', { project: second })).data.id);
    assert.equal((await cadNodes(first)).length, 5);
    assert.equal((await cadNodes(second)).length, 5);
  });

  test('refuses a project without a local folder, bad input, a second ingest, and strangers', async () => {
    assert.deepEqual((await api('POST', '/api/plugins/cad/ingest', {})).data.error, 'invalid_input');
    assert.equal((await api('POST', '/api/plugins/cad/ingest', { project, privacy: 'public' })).status, 400);
    const unknown = await api('POST', '/api/plugins/cad/ingest', { project: 'no-such-project' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.data.error, 'no_local_path');
    await server.pool.query("INSERT INTO project_settings (owner_id, project, local_path) VALUES ($1, 'vanished', $2)", [ownerId, join(folder, 'nope')]);
    assert.equal((await api('POST', '/api/plugins/cad/ingest', { project: 'vanished' })).data.error, 'no_local_path');

    const blocker = startJob(ownerId, 'github.ingest', () => new Promise(() => {}));
    const busy = await api('POST', '/api/plugins/cad/ingest', { project });
    assert.equal(busy.status, 409);
    assert.equal(busy.data.job.id, blocker.id);
    assert.equal((await api('GET', `/api/plugins/cad/jobs/${blocker.id}`)).status, 404, 'another plug-in’s job is not shown here');
    resetJobs();

    const stranger = session(server.base);
    assert.equal((await stranger('POST', '/api/plugins/cad/ingest', { project })).status, 401);
    const other = await registeredSession(server.base);
    assert.equal((await other('POST', '/api/plugins/cad/ingest', { project })).data.error, 'no_local_path', 'another user’s project settings are not theirs');
  });

  test('reports whether CadQuery is available', async () => {
    const { status, data: body } = await api('GET', '/api/plugins/cad/status');
    assert.equal(status, 200);
    assert.equal(typeof body.cadquery.available, 'boolean');
    if (!body.cadquery.available) assert.ok(body.cadquery.reason);
  });

  test('STEP solids get their geometry from CadQuery when it is available, and are still ingested without it', async () => {
    const dir = tempDir('cad-step');
    writeFileSync(join(dir, 'cube.step'), fixture('cube.step'));
    const { cadquery } = await cadQueryForTests({ createCadQuery, defaultSandbox });
    const summary = await ingestCadProject({ ownerId, project: 'step-project', localPath: dir, cadquery, embed: async () => null });
    assert.equal(summary.geometry, 'CadQuery');
    const [node] = await cadNodes('step-project');
    assert.match(node.content, /Geometry: 1 solid\(s\), valid B-rep, volume 1000 mm³/);

    const offline = createCadQuery({ sandbox: { status: async () => ({ available: false, reason: 'test' }), run: async () => { throw new Error('no'); } } });
    const again = await ingestCadProject({ ownerId, project: 'step-project-offline', localPath: dir, cadquery: offline, embed: async () => null });
    assert.match(again.geometry, /^unavailable/);
    const [plain] = await cadNodes('step-project-offline');
    assert.doesNotMatch(plain.content, /Geometry:/);
    assert.equal(plain.type, 'part');
  });
});
