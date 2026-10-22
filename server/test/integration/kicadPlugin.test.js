import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { bomCsv, createKicadPlugin } from '../../src/plugins/kicad/index.js';
import { externalId, ingestProject } from '../../src/plugins/kicad/ingest.js';
import { registerBuiltInPlugins } from '../../src/plugins/registry.js';
import { capabilitiesForTags, getCapability, getVerifier, listPlugins } from '../../src/workspace/capabilities.js';
import { createEventBus } from '../../src/workspace/events.js';
import { createWorker } from '../../src/workspace/runner/index.js';
import { roleTemplate } from '../../src/workspace/roles.js';
import { createSandbox, removeSandbox, sandboxStatus } from '../../src/workspace/sandbox/index.js';
import { createFakeModelPort } from '../fakeModelPort.js';
import { registeredSession, startServer } from '../helpers.js';
import { makeRepo, removeTempDirs, tempDir, useDataDir } from './workspaceSandboxFixtures.js';

// The KiCad capabilities and verifiers as an agent uses them: through the
// registry, on the fixture project, pointing at the ingested nodes, in a
// sandbox copy, and in a whole run by a Hardware Engineer.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'kicad');
const noEmbed = async (texts) => texts.map(() => null);
// A ModelPort as the runner hands it to a capability while the engine is
// online: nothing on it says the call stays on this machine.
const online = (port) => ({ name: 'run', offline: false, stream: port.stream, calls: port.calls });

const tool = await createKicadPlugin().probe();
const os = await sandboxStatus();
const realSkip = !tool.available ? `kicad-cli 8+ is not available (${tool.reason})` : !os.available ? `no OS sandbox (${os.reason})` : false;
if (realSkip) console.log(`# skipping the real kicad-cli checks: ${realSkip}`);

function folder(name) {
  const dir = join(tempDir(`kicad-${name}`), name);
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

const filesOf = (name) => Object.fromEntries(readdirSync(join(FIXTURES, name)).map((file) => [file, readFileSync(join(FIXTURES, name, file), 'utf8')]));

describe('KiCad plug-in', () => {
  let server;
  let ownerId;
  let data;
  let clean;
  let faulty;
  const cap = (name) => getCapability(name);

  before(async () => {
    server = await startServer();
    const api = await registeredSession(server.base);
    ({ data: { userId: ownerId } } = await api('GET', '/api/auth/session'));
    data = useDataDir();
    registerBuiltInPlugins();
    clean = folder('ldo-led');
    faulty = folder('ldo-led-faulty');
    await ingestProject({ ownerId, project: 'ldo', localPath: clean, embed: noEmbed });
    await ingestProject({ ownerId, project: 'ldo-faulty', localPath: faulty, embed: noEmbed });
  });

  after(async () => {
    data.restore();
    removeTempDirs();
    await server.close();
  });

  const ctxFor = (project, localPath, extra = {}) => ({ ownerId, project, localPath, ...extra });
  const idOf = async (project, kind, file, name) =>
    (await server.pool.query('SELECT id FROM nodes WHERE owner_id = $1 AND external_id = $2', [ownerId, externalId(project, kind, file, name)])).rows[0]?.id;

  describe('registration', () => {
    test('registers through the built-in registry beside the code plug-in', () => {
      registerBuiltInPlugins();
      assert.ok(['code', 'kicad'].every((name) => listPlugins().includes(name)), listPlugins().join());
      const names = capabilitiesForTags(['kicad']).map((entry) => entry.name).sort();
      assert.deepEqual(names, ['kicad.bom', 'kicad.footprint_query', 'kicad.net_query', 'kicad.schematic_review']);
      for (const name of names) {
        assert.equal(cap(name).permission, 'read_graph', name);
        assert.equal(cap(name).source, 'kicad', name);
        assert.equal(cap(name).plugin, 'kicad');
      }
      assert.ok(getVerifier('kicad.erc'));
      assert.ok(getVerifier('kicad.drc'));
      // The Hardware Engineer role reaches them through its tag.
      const role = capabilitiesForTags(roleTemplate('hardware_engineer').tags).map((entry) => entry.name);
      assert.ok(names.every((name) => role.includes(name)));
      assert.ok(!role.some((name) => name.startsWith('code.')));
    });
  });

  describe('kicad.net_query', () => {
    test('which pins and symbols are on a net, pointing at the ingested nodes', async () => {
      const result = await cap('kicad.net_query').run({ net: '+3V3' }, ctxFor('ldo', clean));
      assert.equal(result.output.schematic, 'ldo-led.kicad_sch');
      const [net] = result.output.nets;
      assert.equal(net.name, '+3V3');
      assert.equal(net.power, true);
      assert.deepEqual(net.symbols, ['C2', 'R1', 'U1']);
      assert.deepEqual(net.pins.find((pin) => pin.reference === 'U1'), { reference: 'U1', number: '2', name: 'VO', type: 'power_out' });
      const expected = await Promise.all([
        idOf('ldo', 'net', 'ldo-led.kicad_sch', '+3V3'),
        ...['C2', 'R1', 'U1'].map((ref) => idOf('ldo', 'symbol', 'ldo-led.kicad_sch', ref)),
      ]);
      assert.deepEqual(result.touchedNodeIds.sort(), expected.sort());
    });

    test('local labels are found without the sheet slash, and by alias', async () => {
      const led = await cap('kicad.net_query').run({ net: 'LED_A' }, ctxFor('ldo', clean));
      assert.deepEqual(led.output.nets.map((net) => [net.name, net.symbols.join(' ')]), [['/LED_A', 'D1 R1']]);
      const vin = await cap('kicad.net_query').run({ net: 'VIN' }, ctxFor('ldo', clean));
      assert.equal(vin.output.nets[0].name, '+5V');
    });

    test('which nets a symbol touches', async () => {
      const result = await cap('kicad.net_query').run({ symbol: 'u1', schematic: 'ldo-led.kicad_sch' }, ctxFor('ldo', clean));
      assert.deepEqual(result.output.symbol, { reference: 'U1', value: 'AMS1117-3.3', footprint: 'Package_TO_SOT_SMD:SOT-223-3_TabPin2', libId: 'Regulator_Linear:AMS1117-3.3' });
      assert.deepEqual(result.output.nets, ['+3V3', '+5V', 'GND']);
      assert.deepEqual(result.output.pins.map((pin) => `${pin.number}:${pin.net}`), ['1:GND', '2:+3V3', '3:+5V']);
      assert.equal(result.touchedNodeIds.length, 4);
      const d1 = await cap('kicad.net_query').run({ symbol: 'D1' }, ctxFor('ldo-faulty', faulty));
      assert.deepEqual(d1.output.pins.map((pin) => `${pin.number}:${pin.net}`), ['1:null', '2:/LED_A']);
    });

    test('bad input and unknown names fail clearly', async () => {
      const run = (input, ctx = ctxFor('ldo', clean)) => cap('kicad.net_query').run(input, ctx);
      await assert.rejects(run({}), (err) => err.code === 'invalid_input');
      await assert.rejects(run({ net: 'GND', symbol: 'U1' }), (err) => err.code === 'invalid_input');
      await assert.rejects(run({ net: 'NOPE' }), (err) => err.code === 'net_not_found' && /4 nets/.test(err.message));
      await assert.rejects(run({ symbol: 'Q9' }), (err) => err.code === 'symbol_not_found');
      await assert.rejects(run({ net: 'GND', schematic: '../ldo-led-faulty/ldo-led-faulty.kicad_sch' }), (err) => err.code === 'path_escapes');
      await assert.rejects(run({ net: 'GND', schematic: 'ldo-led.kicad_pcb' }), (err) => err.code === 'invalid_input');
      await assert.rejects(run({ net: 'GND', schematic: 'missing.kicad_sch' }), (err) => err.code === 'not_found');
      await assert.rejects(run({ net: 'GND' }, { ownerId, project: 'x' }), (err) => err.code === 'no_checkout');
    });

    test('a folder with two unrelated schematics needs to be told which', async () => {
      const dir = folder('ldo-led');
      writeFileSync(join(dir, 'other.kicad_sch'), readFileSync(join(FIXTURES, 'ldo-led-faulty', 'ldo-led-faulty.kicad_sch')));
      // The one named like the project file wins.
      assert.equal((await cap('kicad.net_query').run({ net: 'GND' }, ctxFor('x', dir))).output.schematic, 'ldo-led.kicad_sch');
      const bare = tempDir('kicad-two');
      writeFileSync(join(bare, 'a.kicad_sch'), readFileSync(join(clean, 'ldo-led.kicad_sch')));
      writeFileSync(join(bare, 'b.kicad_sch'), readFileSync(join(clean, 'ldo-led.kicad_sch')));
      await assert.rejects(cap('kicad.net_query').run({ net: 'GND' }, ctxFor('x', bare)), (err) => err.code === 'ambiguous_design' && err.candidates.length === 2);
      await assert.rejects(cap('kicad.net_query').run({ net: 'GND' }, ctxFor('x', tempDir('kicad-empty'))), (err) => err.code === 'no_design');
    });

    test('reads the run’s sandbox copy when there is one, not the user’s folder', async () => {
      const repo = makeRepo(filesOf('ldo-led'));
      const sandbox = await createSandbox({ runId: randomUUID(), repoPath: repo.repo });
      try {
        // An edit in the copy: the LED label is renamed there only.
        const copy = join(sandbox.worktree, 'ldo-led.kicad_sch');
        writeFileSync(copy, readFileSync(copy, 'utf8').replace('(label "LED_A"', '(label "LED_DRIVE"'));
        const inCopy = await cap('kicad.net_query').run({ net: 'LED_DRIVE' }, ctxFor('ldo', repo.repo, { sandbox }));
        assert.deepEqual(inCopy.output.nets[0].symbols, ['D1', 'R1']);
        await assert.rejects(cap('kicad.net_query').run({ net: 'LED_DRIVE' }, ctxFor('ldo', repo.repo)), (err) => err.code === 'net_not_found');
      } finally {
        await removeSandbox(sandbox);
        repo.cleanup();
      }
    });
  });

  describe('kicad.footprint_query', () => {
    test('filters by reference, value, layer and net', async () => {
      const run = (input) => cap('kicad.footprint_query').run(input, ctxFor('ldo', clean));
      const r1 = await run({ reference: 'R1' });
      assert.equal(r1.output.board, 'ldo-led.kicad_pcb');
      assert.deepEqual(r1.output.footprints, [{
        reference: 'R1', value: '330', footprint: 'Resistor_SMD:R_0603_1608Metric', layer: 'F.Cu', x: 138, y: 100, angle: 90,
        pads: [{ number: '1', net: '+3V3' }, { number: '2', net: '/LED_A' }],
      }]);
      assert.deepEqual(r1.touchedNodeIds, [await idOf('ldo', 'footprint', 'ldo-led.kicad_pcb', 'R1')]);
      assert.deepEqual((await run({ layer: 'B.Cu' })).output.footprints.map((f) => f.reference), ['C2']);
      assert.deepEqual((await run({ net: 'LED_A' })).output.footprints.map((f) => f.reference), ['D1', 'R1']);
      assert.deepEqual((await run({ value: '22U' })).output.footprints.map((f) => f.reference), ['C2']);
      assert.equal((await run({})).output.count, 6);
      await assert.rejects(run({ reference: 'Q1' }), (err) => err.code === 'footprint_not_found');
      await assert.rejects(cap('kicad.footprint_query').run({}, ctxFor('ldo-faulty', faulty)), (err) => err.code === 'no_design');
    });
  });

  describe('kicad.bom', () => {
    test('the BOM as a table and a CSV artifact', async () => {
      const result = await cap('kicad.bom').run({}, ctxFor('ldo', clean));
      assert.deepEqual(result.output.columns, ['references', 'quantity', 'value', 'footprint', 'libIds']);
      assert.equal(result.output.lines, 6);
      assert.equal(result.output.parts, 6);
      assert.deepEqual(result.output.rows.map((row) => `${row.references.join(' ')} ${row.value}`), ['C1 10u', 'C2 22u', 'D1 red', 'J1 Conn_01x02', 'R1 330', 'U1 AMS1117-3.3']);
      const [artifact] = result.artifacts;
      assert.match(artifact.name, /^Bill of materials — ldo-led\.kicad_sch \(6 lines, 6 parts\)/);
      assert.equal(artifact.content.split('\n')[0], 'References,Quantity,Value,Footprint,Library');
      assert.match(artifact.content, /^R1,1,330,Resistor_SMD:R_0603_1608Metric,Device:R$/m);
      assert.equal(result.touchedNodeIds.length, 6, 'every BOM line node');
    });

    test('CSV cells are quoted and cannot become spreadsheet formulas', () => {
      const csv = bomCsv([{ references: ['R1', 'R2'], quantity: 2, value: '=HYPERLINK("x")', footprint: 'a,b', libIds: ['Device:R'] }]);
      assert.equal(csv.split('\n')[1], `R1 R2,2,"'=HYPERLINK(""x"")","a,b",Device:R`);
    });
  });

  describe('kicad.schematic_review', () => {
    const review = (ctx) => cap('kicad.schematic_review').run({}, ctx);

    test('finds the planted faults; a local-only agent’s model words them', async () => {
      const model = createFakeModelPort({
        responses: [(request) => {
          const items = JSON.parse(request.messages[1].content).items;
          return { findings: items.map((item) => ({ id: item.id, text: `Please fix: ${item.fact}` })).concat([{ id: 'made_up:Q1', text: 'Q1 is wrong.' }]) };
        }],
      });
      const result = await review(ctxFor('ldo-faulty', faulty, { model: online(model), agent: { modelPolicy: 'local_only' } }));
      assert.equal(model.calls.length, 1);
      assert.deepEqual(result.output.counts, { missing_footprint: 1, missing_value: 1, no_decoupling: 1, unconnected_pin: 1 });
      assert.deepEqual(result.output.phrasing, { by: 'model', reason: 'local_only_policy', accepted: 4 });
      assert.equal(result.output.issues.length, 4, 'the invented issue is not added');
      assert.ok(result.output.issues.every((issue) => issue.text.startsWith('Please fix: ') && issue.fact && !issue.text.includes('Q1')));
      assert.equal(result.findings.length, 4);
      assert.match(result.findings.find((finding) => /no decoupling/.test(finding.name)).content, /\+3V3/);
      assert.ok(result.touchedNodeIds.includes(await idOf('ldo-faulty', 'net', 'ldo-led-faulty.kicad_sch', '+3V3')));
      assert.ok(result.touchedNodeIds.includes(await idOf('ldo-faulty', 'schematic', 'ldo-led-faulty.kicad_sch')));
    });

    test('private designs are not sent to a model that could reach the cloud', async () => {
      const model = createFakeModelPort({ fallback: { findings: [] } });
      const result = await review(ctxFor('ldo-faulty', faulty, { model: online(model), agent: { modelPolicy: 'local_cloud' } }));
      assert.equal(model.calls.length, 0);
      assert.deepEqual(result.output.phrasing, { by: 'template', reason: 'private_design', accepted: 0 });
      assert.match(result.output.issues.find((issue) => issue.kind === 'unconnected_pin').text, /^D1 pin 1 \(K\) is not connected/);
      // Offline the same call cannot leave the machine, so the model may word it.
      const offline = createFakeModelPort({ fallback: { findings: [{ id: 'missing_value:R1', text: 'R1 needs a value.' }] } });
      const worded = await review(ctxFor('ldo-faulty', faulty, { model: offline, agent: { modelPolicy: 'local_cloud' } }));
      assert.deepEqual(worded.output.phrasing, { by: 'model', reason: 'offline', accepted: 1 });
    });

    test('a cloud-privacy project may use the model; a failing or useless model falls back to the plain wording', async () => {
      const project = 'ldo-faulty-cloud';
      await ingestProject({ ownerId, project, localPath: faulty, embed: noEmbed, privacy: 'cloud' });
      const failing = createFakeModelPort({ responses: [new Error('model down')] });
      const failed = await review(ctxFor(project, faulty, { model: online(failing), agent: { modelPolicy: 'local_cloud' } }));
      assert.equal(failing.calls.length, 1);
      assert.deepEqual(failed.output.phrasing, { by: 'template', reason: 'model_failed', accepted: 0 });
      assert.equal(failed.findings.length, 4);
      const useless = createFakeModelPort({ responses: ['I think the schematic looks great!'] });
      const unusable = await review(ctxFor(project, faulty, { model: online(useless) }));
      assert.deepEqual(unusable.output.phrasing, { by: 'template', reason: 'model_reply_unusable', accepted: 0 });
    });

    test('a clean schematic is reported clean without asking the model', async () => {
      const model = createFakeModelPort();
      const result = await review(ctxFor('ldo', clean, { model: online(model), agent: { modelPolicy: 'local_only' } }));
      assert.equal(model.calls.length, 0);
      assert.deepEqual(result.output.issues, []);
      assert.deepEqual(result.output.phrasing, { by: 'template', reason: 'no_issues', accepted: 0 });
      assert.match(result.findings[0].content, /^No unconnected pins, missing values or footprints, or undecoupled power nets in 6 parts and 4 nets\./);
    });
  });

  describe('kicad.erc and kicad.drc', () => {
    test('report unavailable when kicad-cli is missing or too old, through the registry', async () => {
      if (tool.available) return; // The real tool is covered below.
      for (const name of ['kicad.erc', 'kicad.drc']) {
        const outcome = await getVerifier(name).verify({ output: {} }, ctxFor('ldo', clean));
        assert.equal(outcome.ok, true, name);
        assert.equal(outcome.unavailable, true, name);
        assert.match(outcome.detail, /not run: kicad-cli/);
      }
    });

    test('the real kicad-cli in the OS sandbox: ERC fails the faulty schematic on D1', { skip: realSkip }, async () => {
      const erc = await getVerifier('kicad.erc').verify({ output: {} }, ctxFor('ldo-faulty', faulty));
      assert.equal(erc.ok, false, erc.detail);
      assert.match(erc.detail, /pin_not_connected[\s\S]*D1/);
      const clean_ = await getVerifier('kicad.erc').verify({ output: {} }, ctxFor('ldo', clean));
      assert.ok(!/pin_not_connected/.test(clean_.detail), clean_.detail);
      const drc = await getVerifier('kicad.drc').verify({ output: {} }, ctxFor('ldo', clean));
      assert.equal(typeof drc.ok, 'boolean');
      assert.match(drc.detail, /^DRC ldo-led\.kicad_pcb: \d+ errors?/);
    });
  });

  describe('in a run', () => {
    test('a Hardware Engineer traces a net, reviews the schematic and extracts the BOM', async () => {
      const project = 'run-board';
      await server.pool.query('INSERT INTO project_settings (owner_id, project, local_path) VALUES ($1, $2, $3)', [ownerId, project, faulty]);
      const { rows: [agent] } = await server.pool.query(
        `INSERT INTO agents (owner_id, name, role, level, scopes, model_policy)
         VALUES ($1, 'Hardware', $2, 'supervised', $3, 'local_only') RETURNING id`,
        [ownerId, roleTemplate('hardware_engineer'), { read: { projects: [project], sources: ['kicad'] }, write: { projects: [project] } }]
      );
      const { rows: [run] } = await server.pool.query(
        'INSERT INTO agent_runs (owner_id, agent_id, instructions, project) VALUES ($1, $2, $3, $4) RETURNING id',
        [ownerId, agent.id, 'Review the regulator board and list its parts', project]
      );
      const local = createFakeModelPort({ name: 'local' });
      local.push(
        '1. Trace +3V3.\n2. Review the schematic.\n3. Extract the BOM.',
        { capability: 'kicad.net_query', input: { net: '+3V3' }, summary: 'Who is on the 3.3 V rail' },
        { capability: 'kicad.schematic_review', input: {}, summary: 'Review the schematic' },
        // The review's own model call, routed to the local adapter.
        { findings: [{ id: 'no_decoupling:+3V3', text: 'Add an output capacitor from +3V3 to GND at U1.' }] },
        { capability: 'kicad.bom', input: {}, summary: 'Extract the BOM' },
        { done: true, summary: 'The 3.3 V rail lacks its output capacitor; D1 is unconnected; BOM extracted.' }
      );
      const worker = createWorker({ adapters: { local }, events: createEventBus(), embed: false, leaseMs: 30_000, heartbeatMs: 25, onError: () => {} });
      try {
        await worker.drain();
      } finally {
        worker.abandon();
      }
      const row = (await server.pool.query('SELECT status, error FROM agent_runs WHERE id = $1', [run.id])).rows[0];
      assert.equal(row.status, 'succeeded', row.error);
      const steps = (await server.pool.query('SELECT capability, status, output FROM agent_run_steps WHERE run_id = $1 ORDER BY index', [run.id])).rows;
      assert.deepEqual(steps.map((step) => [step.capability, step.status]), [
        [null, 'done'],
        ['kicad.net_query', 'done'],
        ['kicad.schematic_review', 'done'],
        ['kicad.bom', 'done'],
        [null, 'done'],
      ]);
      assert.equal(steps[2].output.phrasing.by, 'model');
      const notes = (await server.pool.query("SELECT type, content FROM nodes WHERE owner_id = $1 AND project = $2 AND source = 'agent' AND type IN ('finding', 'artifact') ORDER BY created_at", [ownerId, project])).rows;
      assert.ok(notes.some((note) => note.type === 'finding' && /Add an output capacitor from \+3V3 to GND at U1\./.test(note.content)));
      assert.ok(notes.some((note) => note.type === 'finding' && /D1 pin 1 \(K\) is not connected/.test(note.content)));
      assert.ok(notes.some((note) => note.type === 'artifact' && /^Bill of materials — ldo-led-faulty\.kicad_sch[\s\S]*References,Quantity,Value/.test(note.content)));
      // A supervised agent reads without asking.
      assert.equal((await server.pool.query('SELECT count(*)::int AS c FROM agent_approvals WHERE run_id = $1', [run.id])).rows[0].c, 0);
    });

    test('an agent whose read scope leaves out the kicad source is denied', async () => {
      const project = 'run-board';
      const { rows: [agent] } = await server.pool.query(
        `INSERT INTO agents (owner_id, name, role, level, scopes, model_policy)
         VALUES ($1, 'Narrow', $2, 'agentic', $3, 'local_only') RETURNING id`,
        [ownerId, roleTemplate('hardware_engineer'), { read: { projects: [project], sources: ['github'] }, write: { projects: [project] } }]
      );
      const { rows: [run] } = await server.pool.query(
        'INSERT INTO agent_runs (owner_id, agent_id, instructions, project) VALUES ($1, $2, $3, $4) RETURNING id',
        [ownerId, agent.id, 'List the parts', project]
      );
      const local = createFakeModelPort({ name: 'local' });
      local.push('1. BOM.', { capability: 'kicad.bom', input: {}, summary: 'BOM' }, { done: true, summary: 'Could not read the design.' });
      const worker = createWorker({ adapters: { local }, events: createEventBus(), embed: false, leaseMs: 30_000, heartbeatMs: 25, onError: () => {} });
      try {
        await worker.drain();
      } finally {
        worker.abandon();
      }
      const steps = (await server.pool.query('SELECT capability, status, error FROM agent_run_steps WHERE run_id = $1 ORDER BY index', [run.id])).rows;
      assert.deepEqual([steps[1].capability, steps[1].status], ['kicad.bom', 'failed']);
      assert.match(steps[1].error, /denied/);
    });
  });
});
