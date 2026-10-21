import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createCadPlugin } from '../../src/plugins/cad/index.js';
import { createCadQuery, defaultSandbox } from '../../src/plugins/cad/cadquery.js';
import { encodeBinaryStl, parseStl } from '../../src/plugins/cad/stl.js';
import { registerBuiltInPlugins } from '../../src/plugins/registry.js';
import { roleTemplate } from '../../src/workspace/roles.js';
import { capabilitiesForTags, getCapability, getVerifier, listPlugins, resetRegistry } from '../../src/workspace/capabilities.js';
import { createSandbox, createScratchSandbox, removeSandbox } from '../../src/workspace/sandbox/index.js';
import { cadQueryForTests } from '../fixtures/cad/replay.js';
import { box } from '../fixtures/cad/shapes.js';
import { makeRepo, removeTempDirs, tempDir, useDataDir } from './workspaceSandboxFixtures.js';

// The CAD plug-in's capabilities and verifiers against a real project on
// disk. STL work is JavaScript and always runs; STEP geometry, solid
// interference and parametric edits run CadQuery in the OS sandbox when it
// is installed, and otherwise replay CadQuery's recorded answers through the
// same code (test/fixtures/cad/replay.js). The tool-unavailable path is
// tested with a CadQuery that cannot run.

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'cad');
const fixture = (name) => readFileSync(join(FIXTURES, name));

// CadQuery scripts the tests run. Their text is part of the recording key.
export const BRACKET_SCRIPT = [
  'spacing = 50',
  'plate = cq.Workplane("XY").box(80, 20, 5, centered=False)',
  'result = plate.faces(">Z").workplane(origin=(0, 0, 5)).pushPoints([(15, 10), (15 + spacing, 10)]).hole(5)',
  '',
].join('\n');
const DRILL_SCRIPT = 'result = cq.importers.importStep(project_path("cube.step")).faces(">Z").workplane(origin=(5, 5, 10)).hole(4)\n';
const FAILING_SCRIPT = 'raise ValueError("the fillet radius is larger than the edge")\n';
const NO_RESULT_SCRIPT = 'part = cq.Workplane("XY").box(1, 1, 1)\n';
const NETWORK_SCRIPT = 'import socket\nsocket.create_connection(("192.0.2.1", 80), timeout=2)\nresult = cq.Workplane("XY").box(1, 1, 1)\n';

let data;
let project;
let cadquery;
let mode;
let plugin;
let saveRecordings = () => {};
const unavailable = createCadQuery({
  sandbox: {
    status: async () => ({ available: false, reason: 'test: no OS sandbox' }),
    run: async () => {
      throw new Error('nothing may run without a sandbox');
    },
  },
});
let offline;

const cap = (p, name) => p.capabilities.find((c) => c.name === name);
const verifier = (p, name) => p.verifiers.find((v) => v.name === name);
const readCtx = () => ({ localPath: project.repo, project: 'parts', signal: undefined });
const sandboxes = [];
async function sandboxCtx() {
  const sandbox = await createSandbox({ runId: randomUUID(), repoPath: project.repo });
  sandboxes.push(sandbox);
  return { sandbox, localPath: project.repo, project: 'parts' };
}

before(async () => {
  data = useDataDir();
  ({ cadquery, mode, save: saveRecordings } = await cadQueryForTests({ createCadQuery, defaultSandbox }));
  console.log(`# CadQuery: ${mode}`);
  plugin = createCadPlugin({ cadquery });
  offline = createCadPlugin({ cadquery: unavailable });
  const files = {
    'cad.json': JSON.stringify({ units: 'mm', density: { value: 7850, unit: 'kg/m3' }, assembly: ['parts/bracket.step', 'pegs/clear.stl'] }),
    'notes.md': '# Parts\n',
  };
  for (const name of ['cube.stl', 'cube-ascii.stl', 'bracket.stl', 'overlap-a.stl', 'overlap-b.stl', 'touching.stl', 'inner.stl', 'open-box.stl', 'cube.step', 'two-boxes.step', 'two-boxes-apart.step', 'bracket-assembly.step']) {
    files[name] = fixture(name);
  }
  // Pegs for the 80 mm bracket the edit script makes (5 mm holes at x 15
  // and 65, y 10): a 3 mm peg clears the first hole, a 7 mm one does not.
  files['pegs/clear.stl'] = encodeBinaryStl(box([3, 3, 15], [13.5, 8.5, -5]));
  files['pegs/tight.stl'] = encodeBinaryStl(box([7, 7, 15], [11.5, 6.5, -5]));
  project = makeRepo(files, { parent: tempDir('cad-project') });
});

after(async () => {
  saveRecordings();
  for (const sandbox of sandboxes) await removeSandbox(sandbox).catch(() => {});
  data.restore();
  removeTempDirs();
});

describe('registration', () => {
  test('the registry registers the CAD plug-in beside the code plug-in, once', () => {
    resetRegistry();
    registerBuiltInPlugins();
    registerBuiltInPlugins();
    assert.deepEqual(listPlugins(), ['code', 'cad']);
    assert.equal(getCapability('cad.inspect').permission, 'read_graph');
    assert.equal(getCapability('cad.inspect').source, 'cad');
    assert.equal(getCapability('cad.mass_properties').source, 'cad');
    assert.equal(getCapability('cad.interference').source, 'cad');
    assert.equal(getCapability('cad.parametric_edit').permission, 'run_generated_code');
    assert.deepEqual(getCapability('cad.parametric_edit').verifiers, ['cad.valid_geometry', 'cad.dimensions', 'cad.no_interference']);
    for (const name of ['cad.valid_geometry', 'cad.dimensions', 'cad.no_interference']) assert.ok(getVerifier(name), name);
    resetRegistry();
  });

  test('the CAD Designer role reaches every CAD capability through its tags, and the Builder none', () => {
    resetRegistry();
    registerBuiltInPlugins();
    const names = (tags) => capabilitiesForTags(tags).map((c) => c.name).filter((n) => n.startsWith('cad.')).sort();
    assert.deepEqual(names(roleTemplate('cad_designer').tags), ['cad.inspect', 'cad.interference', 'cad.mass_properties', 'cad.parametric_edit']);
    assert.deepEqual(names(roleTemplate('builder').tags), []);
    resetRegistry();
  });
});

describe('cad.inspect', () => {
  test('an STL part: size, volume, centroid and watertightness in the project unit, with a finding', async () => {
    const { output, findings } = await cap(plugin, 'cad.inspect').run({ path: 'cube.stl' }, readCtx());
    assert.equal(output.format, 'stl');
    assert.equal(output.encoding, 'binary');
    assert.equal(output.units, 'mm');
    assert.equal(output.volume, 1000);
    assert.deepEqual(output.centroid, [5, 5, 5]);
    assert.equal(output.watertight, true);
    assert.deepEqual(output.problems, []);
    assert.match(findings[0], /^cube\.stl: 10 × 10 × 10 mm, volume 1000 mm³/);
  });

  test('a section lists the holes, their spacing and their walls', async () => {
    const { output } = await cap(plugin, 'cad.inspect').run({ path: 'bracket.stl', section: { axis: 'z' } }, readCtx());
    assert.equal(output.section.at, 2.5);
    assert.deepEqual(output.section.holeSpacings, [40]);
    assert.equal(output.section.holes.length, 2);
  });

  test('an open mesh is reported with its problems, not refused', async () => {
    const { output, findings } = await cap(plugin, 'cad.inspect').run({ path: 'open-box.stl' }, readCtx());
    assert.equal(output.watertight, false);
    assert.match(output.problems.join(), /not watertight/);
    assert.match(findings[0], /not watertight \(4 open edges\)/);
  });

  test('a STEP assembly: products, what each contains, and no geometry to measure', async () => {
    const { output, findings } = await cap(plugin, 'cad.inspect').run({ path: 'bracket-assembly.step' }, readCtx());
    assert.equal(output.format, 'step');
    assert.equal(output.lengthUnit, 'mm');
    assert.deepEqual(output.products.find((p) => p.id === 'ASM-1').contains.map((c) => [c.id, c.quantity]), [['BRK-1', 1], ['BLT-M4', 2]]);
    assert.deepEqual(output.geometry, { solids: 0 });
    assert.match(findings[0], /1 assembly\(ies\) and 2 part\(s\); no solid geometry/);
  });

  test('a STEP solid: geometry from CadQuery', async () => {
    const { output } = await cap(plugin, 'cad.inspect').run({ path: 'cube.step' }, readCtx());
    assert.equal(output.geometry.valid, true);
    assert.equal(output.geometry.solids, 1);
    assert.ok(Math.abs(output.geometry.volume - 1000) < 1e-6);
    assert.deepEqual(output.geometry.boundingBox.size.map((v) => Math.round(v * 1e6) / 1e6), [10, 10, 10]);
  });

  test('without CadQuery a STEP solid still reads its structure and says the geometry is unavailable', async () => {
    const { output, findings } = await cap(offline, 'cad.inspect').run({ path: 'cube.step' }, readCtx());
    assert.equal(output.products.length, 1);
    assert.equal(output.geometry.unavailable, true);
    assert.match(output.geometry.reason, /no OS sandbox/);
    assert.match(findings[0], /geometry not measured \(CadQuery unavailable\)/);
  });

  test('the project unit comes from cad.json, and a bad cad.json is an error rather than a silent default', async () => {
    const inches = makeRepo({ 'cad.json': JSON.stringify({ units: 'in' }), 'cube.stl': fixture('cube.stl') }, { parent: tempDir('cad-inches') });
    const { output } = await cap(plugin, 'cad.inspect').run({ path: 'cube.stl' }, { localPath: inches.repo });
    assert.equal(output.units, 'in');
    const broken = makeRepo({ 'cad.json': '{ units: mm', 'cube.stl': fixture('cube.stl') }, { parent: tempDir('cad-broken') });
    await assert.rejects(cap(plugin, 'cad.inspect').run({ path: 'cube.stl' }, { localPath: broken.repo }), (err) => err.code === 'invalid_config');
    const furlongs = makeRepo({ 'cad.json': JSON.stringify({ units: 'furlong' }), 'cube.stl': fixture('cube.stl') }, { parent: tempDir('cad-furlong') });
    await assert.rejects(cap(plugin, 'cad.inspect').run({ path: 'cube.stl' }, { localPath: furlongs.repo }), (err) => err.code === 'invalid_units');
  });

  test('paths stay inside the project and name a CAD file', async () => {
    const inspect = (path, ctx = readCtx()) => cap(plugin, 'cad.inspect').run({ path }, ctx);
    await assert.rejects(inspect('../outside.stl'), (err) => err.code === 'path_escapes');
    await assert.rejects(inspect('/etc/passwd.stl'), (err) => err.code === 'path_escapes');
    await assert.rejects(inspect('.git/config.stl'), (err) => err.code === 'path_escapes');
    await assert.rejects(inspect('notes.md'), (err) => err.code === 'unsupported_format');
    await assert.rejects(inspect('missing.stl'), (err) => err.code === 'not_found');
    await assert.rejects(inspect(''), (err) => err.code === 'invalid_input');
    const outside = tempDir('cad-outside');
    writeFileSync(join(outside, 'secret.stl'), fixture('cube.stl'));
    symlinkSync(join(outside, 'secret.stl'), join(project.repo, 'link.stl'));
    await assert.rejects(inspect('link.stl'), (err) => err.code === 'path_escapes');
    await assert.rejects(inspect('cube.stl', {}), (err) => err.code === 'no_checkout');
  });

  test('in a run sandbox it reads the run’s copy, not the user’s checkout', async () => {
    const ctx = await sandboxCtx();
    writeFileSync(join(ctx.sandbox.worktree, 'cube.stl'), encodeBinaryStl(box(20)));
    const { output } = await cap(plugin, 'cad.inspect').run({ path: 'cube.stl' }, ctx);
    assert.equal(output.volume, 8000);
    assert.equal((await cap(plugin, 'cad.inspect').run({ path: 'cube.stl' }, readCtx())).output.volume, 1000);
  });
});

describe('cad.mass_properties', () => {
  test('an STL cube in steel: mass, centre of mass and inertia in SI units', async () => {
    const { output } = await cap(plugin, 'cad.mass_properties').run({ path: 'cube.stl', density: { value: 7.85, unit: 'g/cm3' } }, readCtx());
    assert.equal(output.method, 'mesh');
    assert.equal(output.density.kgPerM3, 7850);
    assert.equal(output.volume.value, 1000);
    assert.equal(output.volume.unit, 'mm^3');
    assert.ok(Math.abs(output.mass.value - 0.00785) < 1e-12);
    assert.deepEqual(output.centreOfMass.value, [5, 5, 5]);
    // m a² / 6 with a = 0.01 m.
    assert.ok(Math.abs(output.inertia.value[0][0] - (0.00785 * 1e-4) / 6) < 1e-15);
    assert.equal(output.inertia.unit, 'kg*m^2');
  });

  test('the density defaults to the project’s, and is required from somewhere', async () => {
    const { output } = await cap(plugin, 'cad.mass_properties').run({ path: 'cube.stl' }, readCtx());
    assert.equal(output.density.kgPerM3, 7850);
    const bare = makeRepo({ 'cube.stl': fixture('cube.stl') }, { parent: tempDir('cad-bare') });
    await assert.rejects(cap(plugin, 'cad.mass_properties').run({ path: 'cube.stl' }, { localPath: bare.repo }), /density is required/);
    await assert.rejects(cap(plugin, 'cad.mass_properties').run({ path: 'cube.stl', density: { value: 1, unit: 'stone/pint' } }, readCtx()), (err) => err.code === 'invalid_units');
  });

  test('a part drawn in inches is converted, not taken as millimetres', async () => {
    const inches = makeRepo({ 'cad.json': JSON.stringify({ units: 'in' }), 'cube.stl': encodeBinaryStl(box(1)) }, { parent: tempDir('cad-inch-mass') });
    const { output } = await cap(plugin, 'cad.mass_properties').run({ path: 'cube.stl', density: { value: 1, unit: 'lb/in3' } }, { localPath: inches.repo });
    assert.ok(Math.abs(output.mass.value - 0.45359237) < 1e-6, `a cubic inch at 1 lb/in³ is a pound, not ${output.mass.value}`);
  });

  test('an open mesh has no mass', async () => {
    await assert.rejects(cap(plugin, 'cad.mass_properties').run({ path: 'open-box.stl' }, readCtx()), (err) => err.code === 'not_watertight');
  });

  test('a STEP solid is measured by CadQuery, and refused without it', async () => {
    const { output } = await cap(plugin, 'cad.mass_properties').run({ path: 'cube.step' }, readCtx());
    assert.equal(output.method, 'brep');
    assert.ok(Math.abs(output.mass.value - 0.00785) < 1e-9);
    assert.ok(Math.abs(output.inertia.value[2][2] - (0.00785 * 1e-4) / 6) < 1e-12);
    await assert.rejects(cap(offline, 'cad.mass_properties').run({ path: 'cube.step' }, readCtx()), (err) => err.code === 'tool_unavailable');
  });
});

describe('cad.interference', () => {
  const check = (p, paths) => cap(p, 'cad.interference').run({ paths }, readCtx());

  test('STL parts: overlapping and nested ones interfere, touching ones do not, without CadQuery', async () => {
    const result = await check(offline, ['overlap-a.stl', 'overlap-b.stl', 'touching.stl', 'inner.stl']);
    const pair = (a, b) => result.output.pairs.find((p) => p.a === a && p.b === b);
    assert.equal(result.output.method, 'mesh');
    assert.equal(pair('overlap-a.stl', 'overlap-b.stl').interferes, true);
    assert.equal(pair('overlap-a.stl', 'touching.stl').interferes, false);
    assert.equal(pair('overlap-a.stl', 'inner.stl').reason, 'b_inside_a');
    assert.equal(pair('overlap-b.stl', 'touching.stl').interferes, true);
    assert.equal(result.output.interfering, true);
    assert.match(result.findings[0], /^Interference: overlap-a\.stl with overlap-b\.stl/);
  });

  test('parts that clear give a no-interference finding', async () => {
    const result = await check(plugin, ['overlap-a.stl', 'touching.stl']);
    assert.equal(result.output.interfering, false);
    assert.match(result.findings[0], /^No interference between overlap-a\.stl, touching\.stl/);
  });

  test('STEP solids are compared with CadQuery booleans, inside one file or across files', async () => {
    const within = await check(plugin, ['two-boxes.step']);
    assert.equal(within.output.method, 'brep');
    assert.equal(within.output.pairs.length, 1);
    assert.equal(within.output.pairs[0].interferes, true);
    assert.ok(Math.abs(within.output.pairs[0].overlapVolume - 125) < 1e-6);

    const across = await check(plugin, ['cube.step', 'two-boxes-apart.step']);
    assert.deepEqual(across.output.pairs.map((p) => [p.a, p.b, p.interferes]), [
      ['cube.step#1', 'two-boxes-apart.step#1', true],
      ['cube.step#1', 'two-boxes-apart.step#2', false],
    ]);
  });

  test('a mix of STL and STEP compares meshes, the STEP tessellated by CadQuery', async () => {
    const result = await check(plugin, ['touching.stl', 'two-boxes-apart.step']);
    assert.equal(result.output.method, 'mesh (STEP tessellated by CadQuery)');
    // touching.stl spans x 10..20; the apart boxes span x 0..10 and 20..30,
    // so it touches both and crosses neither.
    assert.equal(result.output.interfering, false);
  });

  test('STEP needs CadQuery; bad requests are refused', async () => {
    await assert.rejects(check(offline, ['two-boxes.step']), (err) => err.code === 'tool_unavailable');
    await assert.rejects(check(offline, ['cube.stl', 'cube.step']), (err) => err.code === 'tool_unavailable');
    await assert.rejects(check(plugin, []), (err) => err.code === 'invalid_input');
    await assert.rejects(check(plugin, ['cube.stl']), (err) => err.code === 'invalid_input');
    await assert.rejects(cap(plugin, 'cad.interference').run({ paths: ['cube.stl', 'inner.stl'], tolerance: -1 }, readCtx()), (err) => err.code === 'invalid_input');
  });
});

describe('cad.parametric_edit and its verifiers', () => {
  const edit = (p, input, ctx) => cap(p, 'cad.parametric_edit').run(input, ctx);
  async function verifyAll(p, result, ctx) {
    const out = {};
    for (const name of cap(p, 'cad.parametric_edit').verifiers) out[name] = await verifier(p, name).verify(result, ctx);
    return out;
  }

  test('regenerates a bracket in the run’s copy; every verifier measures it again and passes', async () => {
    const ctx = await sandboxCtx();
    const result = await edit(plugin, {
      script: BRACKET_SCRIPT,
      output: 'parts/bracket.step',
      expect: [
        { measure: 'holes.spacing', value: 50, tolerance: 0.1 },
        { measure: 'holes.minWall', min: 4 },
        { measure: 'size.x', value: 80, tolerance: 0.01 },
      ],
    }, ctx);
    assert.equal(result.output.path, 'parts/bracket.step');
    assert.equal(result.output.reported.valid, true);
    assert.equal(result.output.mesh.watertight, true);
    assert.ok(existsSync(join(ctx.sandbox.worktree, 'parts/bracket.step')), 'written into the sandbox copy');
    assert.ok(!existsSync(join(project.repo, 'parts/bracket.step')), 'never into the user’s checkout');
    assert.match(readFileSync(join(ctx.sandbox.worktree, 'parts/bracket.step'), 'latin1'), /^ISO-10303-21;/);
    assert.match(result.artifacts[0].content, /parts\/bracket\.step: 80 × 20 × 5 mm/);

    const verdicts = await verifyAll(plugin, result, ctx);
    assert.equal(verdicts['cad.valid_geometry'].ok, true, verdicts['cad.valid_geometry'].detail);
    assert.equal(verdicts['cad.valid_geometry'].unavailable, undefined);
    assert.equal(verdicts['cad.dimensions'].ok, true, verdicts['cad.dimensions'].detail);
    assert.match(verdicts['cad.dimensions'].detail, /pass holes\.spacing: (50|49\.99)/);
    // cad.json puts the bracket in an assembly with the clear peg.
    assert.equal(verdicts['cad.no_interference'].ok, true, verdicts['cad.no_interference'].detail);
    assert.match(verdicts['cad.no_interference'].detail, /clears pegs\/clear\.stl/);
  });

  test('a dimension that misses, or a part that clashes, fails its verifier', async () => {
    const ctx = await sandboxCtx();
    const result = await edit(plugin, {
      script: BRACKET_SCRIPT,
      output: 'parts/bracket.step',
      expect: [{ measure: 'holes.spacing', value: 40, tolerance: 0.1 }],
      checkAgainst: ['pegs/tight.stl'],
    }, ctx);
    const verdicts = await verifyAll(plugin, result, ctx);
    assert.equal(verdicts['cad.dimensions'].ok, false);
    assert.match(verdicts['cad.dimensions'].detail, /FAIL holes\.spacing: (50|49\.99)\d* \(expected 40 ± 0\.1\)/);
    assert.equal(verdicts['cad.no_interference'].ok, false);
    assert.match(verdicts['cad.no_interference'].detail, /interferes with pegs\/tight\.stl/);
  });

  test('an STL output is in the project unit and checked in JavaScript, even with CadQuery gone by then', async () => {
    const ctx = await sandboxCtx();
    const result = await edit(plugin, { script: BRACKET_SCRIPT, output: 'out/bracket.stl' }, ctx);
    const mesh = parseStl(readFileSync(join(ctx.sandbox.worktree, 'out/bracket.stl')));
    assert.ok(mesh.triangles.length > 0);
    const verdict = await verifier(offline, 'cad.valid_geometry').verify(result, ctx);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.unavailable, undefined, 'an STL is checked, not skipped');
    const dims = await verifier(offline, 'cad.dimensions').verify(result, ctx);
    assert.equal(dims.unavailable, true, 'nothing declared for this output');
  });

  test('a script may read declared project files with project_path()', async () => {
    const ctx = await sandboxCtx();
    const result = await edit(plugin, { script: DRILL_SCRIPT, output: 'cube-drilled.step', inputs: ['cube.step'], expect: [{ measure: 'volume', max: 999 }] }, ctx);
    assert.ok(result.output.reported.volume < 1000);
    const dims = await verifier(plugin, 'cad.dimensions').verify(result, ctx);
    assert.equal(dims.ok, true, dims.detail);
  });

  test('a run with no checkout copy keeps the part in its scratch directory, where later reads find it', async () => {
    const sandbox = await createScratchSandbox({ runId: randomUUID() });
    sandboxes.push(sandbox);
    const ctx = { sandbox, localPath: project.repo };
    await edit(plugin, { script: BRACKET_SCRIPT, output: 'bracket.stl' }, ctx);
    assert.ok(existsSync(join(sandbox.scratch, 'cad-out', 'bracket.stl')));
    const { output } = await cap(plugin, 'cad.inspect').run({ path: 'bracket.stl' }, ctx);
    assert.deepEqual(output.boundingBox.size.map((v) => Math.round(v)), [80, 20, 5]);
    // The checkout's own files are still readable beside it.
    assert.equal((await cap(plugin, 'cad.inspect').run({ path: 'cube.stl' }, ctx)).output.volume, 1000);
  });

  test('a failing script, a script with no result and a script that reaches for the network all fail the step', async () => {
    const ctx = await sandboxCtx();
    await assert.rejects(edit(plugin, { script: FAILING_SCRIPT, output: 'x.step' }, ctx), (err) => err.code === 'script_error' && /fillet radius/.test(err.message));
    await assert.rejects(edit(plugin, { script: NO_RESULT_SCRIPT, output: 'x.step' }, ctx), (err) => err.code === 'no_result');
    await assert.rejects(edit(plugin, { script: NETWORK_SCRIPT, output: 'x.step' }, ctx), (err) => err.code === 'script_error' && /(unreachable|OSError|timed out)/i.test(err.message));
    assert.ok(!existsSync(join(ctx.sandbox.worktree, 'x.step')), 'nothing is written for a failed edit');
  });

  test('without CadQuery the edit refuses and writes nothing', async () => {
    const ctx = await sandboxCtx();
    await assert.rejects(edit(offline, { script: BRACKET_SCRIPT, output: 'parts/bracket.step' }, ctx), (err) => err.code === 'tool_unavailable' && /no OS sandbox/.test(err.message));
    assert.ok(!existsSync(join(ctx.sandbox.worktree, 'parts/bracket.step')));
  });

  test('refuses to run outside a run sandbox, or to write outside the project or in another format', async () => {
    await assert.rejects(edit(plugin, { script: BRACKET_SCRIPT, output: 'b.step' }, readCtx()), (err) => err.code === 'sandbox_required');
    const ctx = await sandboxCtx();
    await assert.rejects(edit(plugin, { script: BRACKET_SCRIPT, output: 'b.obj' }, ctx), (err) => err.code === 'unsupported_format');
    await assert.rejects(edit(plugin, { script: '', output: 'b.step' }, ctx), (err) => err.code === 'invalid_input');
    await assert.rejects(edit(plugin, { script: BRACKET_SCRIPT, output: 'b.step', expect: [{ measure: 'colour', value: 1 }] }, ctx), (err) => err.code === 'invalid_input');
    await assert.rejects(edit(plugin, { script: BRACKET_SCRIPT, output: 'b.step', timeoutMs: 10 }, ctx), (err) => err.code === 'invalid_input');
    await assert.rejects(edit(plugin, { script: BRACKET_SCRIPT, output: 'b.step', inputs: ['../../etc/passwd.step'] }, ctx), (err) => err.code === 'path_escapes');
  });

  test('an output path that leaves the copy is refused before the script runs', async () => {
    const ctx = await sandboxCtx();
    await assert.rejects(edit(plugin, { script: BRACKET_SCRIPT, output: '../escape.step' }, ctx), (err) => err.code === 'path_escapes');
    assert.ok(!existsSync(join(ctx.sandbox.root, 'escape.step')));
  });

  test('verifiers report themselves unavailable, never passed, when they cannot check', async () => {
    const ctx = await sandboxCtx();
    const stepResult = { output: { path: 'cube.step', checkAgainst: ['two-boxes-apart.step'], expect: [{ measure: 'volume', value: 1000, tolerance: 1 }] } };
    for (const name of ['cad.valid_geometry', 'cad.dimensions', 'cad.no_interference']) {
      const verdict = await verifier(offline, name).verify(stepResult, ctx);
      assert.equal(verdict.unavailable, true, name);
      assert.match(verdict.detail, /^unavailable: .*CadQuery/, name);
    }
    for (const name of ['cad.valid_geometry', 'cad.dimensions', 'cad.no_interference']) {
      const verdict = await verifier(plugin, name).verify({ output: { note: 'no part' } }, ctx);
      assert.equal(verdict.unavailable, true, name);
    }
  });

  test('cad.valid_geometry fails a broken mesh; cad.dimensions applies cad.json’s declarations', async () => {
    const ctx = await sandboxCtx();
    const broken = await verifier(plugin, 'cad.valid_geometry').verify({ output: { path: 'open-box.stl' } }, ctx);
    assert.equal(broken.ok, false);
    assert.match(broken.detail, /not watertight/);

    writeFileSync(join(ctx.sandbox.worktree, 'cad.json'), JSON.stringify({ dimensions: [{ file: 'bracket.stl', measure: 'holes.spacing', value: 50, tolerance: 0.1 }] }));
    const declared = await verifier(plugin, 'cad.dimensions').verify({ output: { path: 'bracket.stl' } }, ctx);
    assert.equal(declared.ok, false);
    assert.match(declared.detail, /FAIL holes\.spacing: 40/);
  });
});
