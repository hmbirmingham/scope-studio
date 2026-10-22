import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { externalId, ingestProject } from '../../src/plugins/kicad/ingest.js';
import { startJob } from '../../src/plugins/jobs.js';
import { registeredSession, session, startServer } from '../helpers.js';
import { removeTempDirs, tempDir } from './workspaceSandboxFixtures.js';

// KiCad ingest from a project's local folder: the nodes and links it
// writes, idempotent re-ingest, what a change to the files does to the
// graph, and the route's job and error paths.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'kicad');

function projectFolder() {
  const dir = join(tempDir('kicad-project'), 'ldo-led');
  cpSync(join(FIXTURES, 'ldo-led'), dir, { recursive: true });
  return dir;
}

// A deterministic stand-in for the embedding model that records what it
// was asked to embed.
function fakeEmbed({ fail = false } = {}) {
  const calls = [];
  const embed = async (texts) => {
    calls.push(texts);
    if (fail) return texts.map(() => null);
    return texts.map((text) => Array.from({ length: 768 }, (_, i) => ((text.length + i) % 7) / 7));
  };
  return { embed, calls, count: () => calls.flat().length };
}

describe('KiCad ingest', () => {
  let server;
  let api;
  let ownerId;

  before(async () => {
    server = await startServer();
    api = await registeredSession(server.base);
    ({ data: { userId: ownerId } } = await api('GET', '/api/auth/session'));
  });

  after(async () => {
    removeTempDirs();
    await server.close();
  });

  const nodesOf = async (project, owner = ownerId) =>
    (await server.pool.query(
      "SELECT id, type, content, external_id, privacy, project, embedding IS NOT NULL AS embedded FROM nodes WHERE owner_id = $1 AND source = 'kicad' AND project = $2 ORDER BY external_id",
      [owner, project]
    )).rows;
  const nodeId = async (project, kind, file, name) =>
    (await server.pool.query('SELECT id FROM nodes WHERE owner_id = $1 AND external_id = $2', [ownerId, externalId(project, kind, file, name)])).rows[0]?.id;
  // The links from one node, as "<type> <target external id tail>".
  const linksFrom = async (id) =>
    (await server.pool.query(
      `SELECT r.type, n.type AS target_type, n.external_id FROM node_relationships r JOIN nodes n ON n.id = r.target_id
       WHERE r.source_id = $1 ORDER BY r.type, n.external_id`,
      [id]
    )).rows.map((row) => `${row.type} ${row.target_type}:${row.external_id.split('|').slice(3).join('|') || row.external_id.split('|')[2]}`);

  async function waitForJob(id) {
    for (let i = 0; i < 400; i++) {
      const { status, data } = await api('GET', `/api/plugins/kicad/jobs/${id}`);
      assert.equal(status, 200);
      if (data.state !== 'running') return data;
      await sleep(25);
    }
    throw new Error('the ingest job did not finish');
  }

  test('ingests a project folder through the route, as a background job', async () => {
    const dir = projectFolder();
    // Things the walk must skip or report: KiCad's backups, a file that is
    // not a schematic, and a symlink out of the folder.
    mkdirSync(join(dir, 'ldo-led-backups'));
    writeFileSync(join(dir, 'ldo-led-backups', 'old.kicad_sch'), readFileSync(join(dir, 'ldo-led.kicad_sch')));
    writeFileSync(join(dir, 'broken.kicad_sch'), '(kicad_sch (version 20231120)');
    symlinkSync(join(FIXTURES, 'ldo-led-faulty', 'ldo-led-faulty.kicad_sch'), join(dir, 'linked.kicad_sch'));

    assert.equal((await api('PUT', '/api/projects/settings', { project: 'ldo-led', localPath: dir })).status, 200);
    const started = await api('POST', '/api/plugins/kicad/ingest', { project: 'ldo-led' });
    assert.equal(started.status, 202);
    assert.equal(started.data.kind, 'kicad.ingest');
    const job = await waitForJob(started.data.id);
    assert.equal(job.state, 'done', job.error);
    const summary = job.summary;
    assert.deepEqual(
      [summary.schematics, summary.boards, summary.symbols, summary.nets, summary.bomRows, summary.footprints, summary.boardNets],
      [1, 1, 6, 4, 6, 6, 4]
    );
    assert.equal(summary.nodes, 1 + 6 + 4 + 6 + 1 + 6 + 4);
    assert.deepEqual(summary.errors.map((entry) => [entry.file, entry.error]), [['broken.kicad_sch', 'parse_error']]);
    assert.equal(summary.truncated, false);
    assert.equal(job.progress.stage, 'done');

    const nodes = await nodesOf('ldo-led');
    assert.equal(nodes.length, summary.nodes);
    assert.ok(nodes.every((node) => node.privacy === 'local'), 'files on this machine stay on it');
    const types = {};
    for (const node of nodes) types[node.type] = (types[node.type] ?? 0) + 1;
    assert.deepEqual(types, { schematic: 1, symbol: 6, net: 8, bom_row: 6, board: 1, footprint: 6 });
    assert.ok(!nodes.some((node) => /old\.kicad_sch|linked/.test(node.external_id)), 'backups and symlinks are skipped');

    const u1 = nodes.find((node) => node.external_id === externalId('ldo-led', 'symbol', 'ldo-led.kicad_sch', 'U1'));
    assert.match(u1.content, /^Symbol U1: AMS1117-3\.3 — Regulator_Linear:AMS1117-3\.3/);
    assert.match(u1.content, /Pins: 1 GND → GND, 2 VO → \+3V3, 3 VI → \+5V/);
    const bomRow = nodes.find((node) => node.type === 'bom_row' && node.content.includes('22u'));
    assert.match(bomRow.content, /1 × 22u, footprint Capacitor_SMD:C_0805_2012Metric — C2/);
  });

  test('links: nets connect symbols, footprints implement symbols, everything is part of its file', async () => {
    const sch = 'ldo-led.kicad_sch';
    const pcb = 'ldo-led.kicad_pcb';
    assert.deepEqual(await linksFrom(await nodeId('ldo-led', 'net', sch, '+3V3')), [
      'connects symbol:C2', 'connects symbol:R1', 'connects symbol:U1', `part_of schematic:${sch}`,
    ]);
    assert.deepEqual(await linksFrom(await nodeId('ldo-led', 'footprint', pcb, 'R1')), [
      'implements symbol:R1', `part_of board:${pcb}`,
    ]);
    assert.deepEqual(await linksFrom(await nodeId('ldo-led', 'net', pcb, '/LED_A')), [
      'connects footprint:D1', 'connects footprint:R1', `part_of board:${pcb}`,
    ]);
    assert.deepEqual(await linksFrom(await nodeId('ldo-led', 'symbol', sch, 'D1')), [`part_of schematic:${sch}`]);
    const bom = (await nodesOf('ldo-led')).find((node) => node.type === 'bom_row');
    assert.deepEqual(await linksFrom(bom.id), [`part_of schematic:${sch}`]);
  });

  test('re-ingest is idempotent, and only changed content is embedded again', async () => {
    const dir = projectFolder();
    const first = fakeEmbed();
    const summary = await ingestProject({ ownerId, project: 'again', localPath: dir, embed: first.embed });
    assert.equal(first.count(), summary.nodes, 'everything is embedded the first time');
    assert.equal(summary.embedded, summary.nodes);
    const before = await nodesOf('again');
    const edges = (await server.pool.query('SELECT count(*)::int AS c FROM node_relationships r JOIN nodes n ON n.id = r.source_id WHERE n.project = $1', ['again'])).rows[0].c;

    const second = fakeEmbed();
    const again = await ingestProject({ ownerId, project: 'again', localPath: dir, embed: second.embed });
    assert.equal(second.count(), 0, 'nothing changed, nothing is embedded');
    assert.equal(again.pruned, 0);
    const afterNodes = await nodesOf('again');
    assert.deepEqual(afterNodes.map((node) => [node.id, node.content]), before.map((node) => [node.id, node.content]));
    assert.ok(afterNodes.every((node) => node.embedded));
    assert.equal((await server.pool.query('SELECT count(*)::int AS c FROM node_relationships r JOIN nodes n ON n.id = r.source_id WHERE n.project = $1', ['again'])).rows[0].c, edges);
  });

  test('a changed design updates nodes in place, prunes what is gone and rebuilds links; agent notes survive', async () => {
    const dir = projectFolder();
    await ingestProject({ ownerId, project: 'changing', localPath: dir, embed: fakeEmbed().embed });
    const sch = 'ldo-led.kicad_sch';
    const r1 = await nodeId('changing', 'symbol', sch, 'R1');
    const c2 = await nodeId('changing', 'symbol', sch, 'C2');
    assert.ok(r1 && c2);
    // An agent's finding derived from R1.
    const { rows: [note] } = await server.pool.query(
      "INSERT INTO nodes (owner_id, type, content, source, project) VALUES ($1, 'finding', 'R1 sets the LED current', 'agent', 'changing') RETURNING id",
      [ownerId]
    );
    await server.pool.query("INSERT INTO node_relationships (source_id, target_id, type) VALUES ($1, $2, 'derived_from')", [note.id, r1]);

    // The faulty schematic: C2 removed, R1's value cleared, TP1 added.
    writeFileSync(join(dir, sch), readFileSync(join(FIXTURES, 'ldo-led-faulty', 'ldo-led-faulty.kicad_sch')));
    const embed = fakeEmbed({ fail: true });
    const summary = await ingestProject({ ownerId, project: 'changing', localPath: dir, embed: embed.embed });
    assert.ok(summary.pruned >= 2, 'C2 and its BOM line are gone');

    assert.equal(await nodeId('changing', 'symbol', sch, 'C2'), undefined);
    assert.ok(await nodeId('changing', 'symbol', sch, 'TP1'));
    assert.equal(await nodeId('changing', 'symbol', sch, 'R1'), r1, 'R1 keeps its node');
    const r1Row = (await nodesOf('changing')).find((node) => node.id === r1);
    assert.match(r1Row.content, /Symbol R1: \(no value\)/);
    assert.equal(r1Row.embedded, false, 'a changed node whose new vector failed is cleared for the backfill');
    assert.deepEqual(await linksFrom(await nodeId('changing', 'net', sch, '+3V3')), ['connects symbol:R1', 'connects symbol:U1', `part_of schematic:${sch}`]);
    // The board still has C2, but there is no symbol for it to implement.
    assert.deepEqual(await linksFrom(await nodeId('changing', 'footprint', 'ldo-led.kicad_pcb', 'C2')), ['part_of board:ldo-led.kicad_pcb']);
    const kept = await server.pool.query("SELECT 1 FROM node_relationships WHERE source_id = $1 AND target_id = $2 AND type = 'derived_from'", [note.id, r1]);
    assert.equal(kept.rowCount, 1, 'the agent’s link to R1 survives re-ingest');
  });

  test('a design that ingested before but now fails to load keeps its nodes and the notes linked to them', async () => {
    const dir = projectFolder();
    const sch = 'ldo-led.kicad_sch';
    const pcb = 'ldo-led.kicad_pcb';
    await ingestProject({ ownerId, project: 'half-saved', localPath: dir, embed: fakeEmbed().embed });
    const before = await nodesOf('half-saved');
    const r1 = await nodeId('half-saved', 'symbol', sch, 'R1');
    const r1Footprint = await nodeId('half-saved', 'footprint', pcb, 'R1');
    const { rows: [note] } = await server.pool.query(
      "INSERT INTO nodes (owner_id, type, content, source, project) VALUES ($1, 'finding', 'R1 sets the LED current', 'agent', 'half-saved') RETURNING id",
      [ownerId]
    );
    await server.pool.query(
      "INSERT INTO node_relationships (source_id, target_id, type) VALUES ($1, $2, 'derived_from'), ($1, $3, 'derived_from')",
      [note.id, r1, r1Footprint]
    );

    // A half-saved schematic and board: both stop mid-file.
    for (const file of [sch, pcb]) {
      const text = readFileSync(join(dir, file), 'utf8');
      writeFileSync(join(dir, file), text.slice(0, Math.floor(text.length / 2)));
    }
    const summary = await ingestProject({ ownerId, project: 'half-saved', localPath: dir, embed: fakeEmbed().embed });
    assert.deepEqual(summary.errors.map((entry) => entry.file), [pcb, sch]);
    assert.equal(summary.pruned, 0, 'nothing of a design that failed to load is pruned');
    assert.deepEqual((await nodesOf('half-saved')).map((node) => node.id), before.map((node) => node.id));
    assert.equal(await nodeId('half-saved', 'symbol', sch, 'R1'), r1);
    const links = await server.pool.query("SELECT target_id FROM node_relationships WHERE source_id = $1 AND type = 'derived_from' ORDER BY target_id", [note.id]);
    assert.deepEqual(links.rows.map((row) => row.target_id), [r1, r1Footprint].sort());

    // Once the schematic loads again, pruning applies to it as usual.
    writeFileSync(join(dir, sch), readFileSync(join(FIXTURES, 'ldo-led-faulty', 'ldo-led-faulty.kicad_sch')));
    const repaired = await ingestProject({ ownerId, project: 'half-saved', localPath: dir, embed: fakeEmbed().embed });
    assert.deepEqual(repaired.errors.map((entry) => entry.file), [pcb]);
    assert.equal(await nodeId('half-saved', 'symbol', sch, 'C2'), undefined, 'C2 left the repaired schematic');
    assert.equal(await nodeId('half-saved', 'symbol', sch, 'R1'), r1);
    assert.equal(await nodeId('half-saved', 'footprint', pcb, 'R1'), r1Footprint, 'the board still fails, so its footprints stay');
  });

  test('projects and owners are kept apart', async () => {
    const dir = projectFolder();
    await ingestProject({ ownerId, project: 'one', localPath: dir, embed: fakeEmbed().embed });
    await ingestProject({ ownerId, project: 'two', localPath: dir, embed: fakeEmbed().embed, privacy: 'cloud' });
    const other = await registeredSession(server.base);
    const { data: { userId: otherId } } = await other('GET', '/api/auth/session');
    await ingestProject({ ownerId: otherId, project: 'one', localPath: dir, embed: fakeEmbed().embed });

    const one = await nodesOf('one');
    const two = await nodesOf('two');
    const theirs = await nodesOf('one', otherId);
    assert.equal(one.length, two.length);
    assert.equal(theirs.length, one.length);
    assert.ok(two.every((node) => node.privacy === 'cloud'));
    assert.equal(new Set([...one, ...theirs].map((node) => node.id)).size, one.length * 2);
    // Re-ingesting project two removes nothing from project one.
    writeFileSync(join(dir, 'ldo-led.kicad_sch'), readFileSync(join(FIXTURES, 'ldo-led-faulty', 'ldo-led-faulty.kicad_sch')));
    await ingestProject({ ownerId, project: 'two', localPath: dir, embed: fakeEmbed().embed });
    assert.equal((await nodesOf('one')).length, one.length);
  });

  test('a missing folder fails the ingest cleanly', async () => {
    await assert.rejects(ingestProject({ ownerId, project: 'gone', localPath: join(tempDir('kicad-gone'), 'nope') }), (err) => err.code === 'no_checkout');
    await assert.rejects(ingestProject({ ownerId, project: 'gone', localPath: tempDir('kicad-x'), privacy: 'public' }), (err) => err.code === 'invalid_input');
  });

  test('route errors: validation, no folder, one ingest at a time, unknown jobs, sign-in', async () => {
    assert.deepEqual((await api('POST', '/api/plugins/kicad/ingest', {})).data.error, 'invalid_project');
    assert.deepEqual((await api('POST', '/api/plugins/kicad/ingest', { project: 'ldo-led', privacy: 'public' })).data.error, 'invalid_privacy');
    const unbound = await api('POST', '/api/plugins/kicad/ingest', { project: 'never-bound' });
    assert.equal(unbound.status, 400);
    assert.equal(unbound.data.error, 'no_local_path');

    let release;
    const blocker = startJob(ownerId, 'github.ingest', () => new Promise((resolve) => { release = resolve; }));
    const busy = await api('POST', '/api/plugins/kicad/ingest', { project: 'ldo-led' });
    assert.equal(busy.status, 409);
    assert.equal(busy.data.error, 'ingest_running');
    // A GitHub job is not readable through the KiCad route.
    assert.equal((await api('GET', `/api/plugins/kicad/jobs/${blocker.id}`)).status, 404);
    release({});
    await sleep(10);

    assert.equal((await api('GET', '/api/plugins/kicad/jobs/00000000-0000-4000-8000-000000000000')).status, 404);
    const anonymous = session(server.base);
    assert.equal((await anonymous('POST', '/api/plugins/kicad/ingest', { project: 'ldo-led' })).status, 401);
    assert.equal((await anonymous('GET', '/api/plugins/kicad/status')).status, 401);
  });

  test('status says whether kicad-cli can run ERC and DRC here', async () => {
    const { status, data } = await api('GET', '/api/plugins/kicad/status');
    assert.equal(status, 200);
    assert.equal(typeof data.kicadCli.available, 'boolean');
    if (!data.kicadCli.available) assert.ok(data.kicadCli.reason);
  });
});
