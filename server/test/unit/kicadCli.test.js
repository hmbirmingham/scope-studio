import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { createChecker, createToolProbe, parseVersion, summarizeReport } from '../../src/plugins/kicad/cli.js';

// ERC and DRC verifiers without kicad-cli: the tool probe, the report
// reader and the checker's plumbing, with a fake OS sandbox that writes the
// recorded report where kicad-cli would. The real tool runs in
// test/integration/kicadPlugin.test.js when it is installed.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'kicad');
const report = (name) => JSON.parse(readFileSync(join(FIXTURES, 'reports', name), 'utf8'));
const available = async () => ({ available: true, path: '/usr/bin/kicad-cli', version: '8.0.5' });

const scratches = [];
after(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

// A sandbox that records what it was asked to run and plays kicad-cli by
// writing the given report to the --output path.
function fakeSandbox({ reply, status = { available: true, mechanism: 'bwrap' } } = {}) {
  const calls = [];
  return {
    calls,
    status: async () => status,
    run: async (options) => {
      const outputAt = options.args.indexOf('--output') + 1;
      const input = options.args.at(-1);
      calls.push({ ...options, copied: readdirSync(dirname(input)).sort(), input });
      const result = typeof reply === 'function' ? reply(options) : reply;
      if (result?.report !== undefined) writeFileSync(options.args[outputAt], typeof result.report === 'string' ? result.report : JSON.stringify(result.report));
      return { ok: (result?.exitCode ?? 0) === 0, exitCode: result?.exitCode ?? 0, timedOut: false, output: result?.output ?? '' };
    },
  };
}

function checker(sandbox, probe = available) {
  return createChecker({
    sandbox,
    probe,
    makeScratch: async () => {
      const dir = mkdtempSync(join(tmpdir(), 'scope-kicad-check-'));
      scratches.push(dir);
      return { scratch: dir };
    },
    removeScratch: async (scratch) => rmSync(scratch.scratch, { recursive: true, force: true }),
  });
}

const ctxFor = (folder) => ({ localPath: join(FIXTURES, folder), project: 'p' });

describe('kicad-cli probe', () => {
  test('parses versions from kicad-cli output', () => {
    assert.deepEqual(parseVersion('8.0.5\n'), { text: '8.0.5', major: 8, minor: 0 });
    assert.deepEqual(parseVersion('(9.0.1-1)'), { text: '9.0.1', major: 9, minor: 0 });
    assert.equal(parseVersion('no version here'), null);
  });

  test('missing, too old, broken and current kicad-cli', async () => {
    assert.deepEqual(await createToolProbe({ find: () => null })(), { available: false, reason: 'kicad-cli is not installed' });

    const old = await createToolProbe({ find: () => '/usr/bin/kicad-cli', run: async () => ({ err: null, stdout: '7.0.11\n', stderr: '' }) })();
    assert.equal(old.available, false);
    assert.match(old.reason, /7\.0\.11 has no ERC\/DRC commands/);

    const broken = await createToolProbe({ find: () => '/usr/bin/kicad-cli', run: async () => ({ err: new Error('exit 127'), stdout: '', stderr: 'libwx missing' }) })();
    assert.equal(broken.available, false);
    assert.match(broken.reason, /libwx missing/);

    let runs = 0;
    const probe = createToolProbe({ find: () => '/usr/bin/kicad-cli', run: async (file, args) => {
      runs += 1;
      assert.deepEqual([file, args], ['/usr/bin/kicad-cli', ['version']]);
      return { err: null, stdout: '8.0.5\n', stderr: '' };
    } });
    assert.deepEqual(await probe(), { available: true, path: '/usr/bin/kicad-cli', version: '8.0.5' });
    await probe();
    assert.equal(runs, 1, 'the answer is kept');
  });
});

describe('kicad-cli reports', () => {
  test('ERC: errors and warnings are counted per sheet; excluded entries are not', () => {
    const clean = summarizeReport('erc', report('erc-ldo-led.json'));
    assert.deepEqual([clean.errors, clean.warnings, clean.kicadVersion], [0, 1, '8.0.5']);
    const faulty = summarizeReport('erc', report('erc-ldo-led-faulty.json'));
    assert.deepEqual([faulty.errors, faulty.warnings, faulty.total], [1, 1, 2]);
    assert.equal(faulty.violations[0].type, 'pin_not_connected');
    assert.deepEqual(faulty.violations[0].items, ['Symbol D1 Pin 1 [K, Passive, Line]']);
    assert.equal(faulty.violations[0].sheet, '/');
  });

  test('DRC: violations, unconnected items and schematic parity all count', () => {
    const drc = summarizeReport('drc', report('drc-ldo-led.json'));
    assert.deepEqual([drc.errors, drc.warnings], [2, 1]);
    assert.deepEqual(drc.violations.map((entry) => entry.group).sort(), ['unconnected_items', 'unconnected_items', 'violations']);
  });

  test('a report of the wrong shape is refused, not read as clean', () => {
    assert.throws(() => summarizeReport('erc', {}), /no sheets/);
    assert.throws(() => summarizeReport('drc', { sheets: [] }), /no violations list/);
    assert.throws(() => summarizeReport('erc', null), /not a JSON object/);
  });
});

describe('ERC and DRC verifiers', () => {
  test('ERC runs kicad-cli on a copy of the schematic in the OS sandbox and passes a clean design', async () => {
    const sandbox = fakeSandbox({ reply: { report: report('erc-ldo-led.json') } });
    const outcome = await checker(sandbox).check('erc', { output: {} }, ctxFor('ldo-led'));
    assert.equal(outcome.ok, true, outcome.detail);
    assert.match(outcome.detail, /^ERC ldo-led\.kicad_sch: 0 errors, 1 warning/);
    assert.equal(sandbox.calls.length, 1);
    const [call] = sandbox.calls;
    assert.equal(call.command, '/usr/bin/kicad-cli');
    assert.deepEqual(call.args.slice(0, 8), ['sch', 'erc', '--format', 'json', '--units', 'mm', '--severity-all', '--output']);
    // The copy holds the schematic and its project file, not the board, and
    // lives in the scratch directory, the only writable mount.
    assert.deepEqual(call.copied, ['ldo-led.kicad_pro', 'ldo-led.kicad_sch']);
    assert.ok(call.input.startsWith(call.writable[0]));
    assert.ok(!call.input.startsWith(FIXTURES), 'kicad-cli never sees the project folder itself');
    assert.equal(call.readOnly, undefined);
    assert.deepEqual(call.protect, [join(FIXTURES, 'ldo-led')]);
    assert.ok(!existsSync(call.writable[0]), 'the scratch copy is removed');
  });

  test('ERC fails a design with errors and names them', async () => {
    const sandbox = fakeSandbox({ reply: { report: report('erc-ldo-led-faulty.json') } });
    const outcome = await checker(sandbox).check('erc', { output: {} }, ctxFor('ldo-led-faulty'));
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /1 error, 1 warning/);
    assert.match(outcome.detail, /pin_not_connected: Pin not connected \(Symbol D1 Pin 1/);
    assert.equal(outcome.checks[0].errors, 1);
  });

  test('DRC checks the board with its project file', async () => {
    const sandbox = fakeSandbox({ reply: { report: report('drc-ldo-led.json') } });
    const outcome = await checker(sandbox).check('drc', { output: { board: 'ldo-led.kicad_pcb' } }, ctxFor('ldo-led'));
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /DRC ldo-led\.kicad_pcb: 2 errors, 1 warning/);
    assert.deepEqual(sandbox.calls[0].args.slice(0, 2), ['pcb', 'drc']);
    assert.deepEqual(sandbox.calls[0].copied, ['ldo-led.kicad_pcb', 'ldo-led.kicad_pro']);
  });

  test('without kicad-cli the check is unavailable, not passed, and nothing runs', async () => {
    const sandbox = fakeSandbox({ reply: { report: report('erc-ldo-led.json') } });
    const missing = async () => ({ available: false, reason: 'kicad-cli is not installed' });
    const outcome = await checker(sandbox, missing).check('erc', { output: {} }, ctxFor('ldo-led'));
    assert.deepEqual(outcome, { ok: true, unavailable: true, detail: 'ERC not run: kicad-cli is not installed' });
    assert.equal(sandbox.calls.length, 0);
  });

  test('without an OS sandbox kicad-cli is not run and the step is unverified', async () => {
    const sandbox = fakeSandbox({ status: { available: false, reason: 'missing bwrap' } });
    const outcome = await checker(sandbox).check('drc', { output: {} }, ctxFor('ldo-led'));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.unverified, true);
    assert.match(outcome.detail, /missing bwrap/);
    assert.equal(sandbox.calls.length, 0);
  });

  test('kicad-cli failing without a report, or writing garbage, fails the check', async () => {
    const crashed = await checker(fakeSandbox({ reply: { exitCode: 3, output: 'Failed to load schematic' } })).check('erc', { output: {} }, ctxFor('ldo-led'));
    assert.equal(crashed.ok, false);
    assert.match(crashed.detail, /exited 3 without a report[\s\S]*Failed to load schematic/);
    const garbled = await checker(fakeSandbox({ reply: { report: '{"sheets": ' } })).check('erc', { output: {} }, ctxFor('ldo-led'));
    assert.equal(garbled.ok, false);
    assert.match(garbled.detail, /unreadable report/);
  });

  test('nothing to check is unavailable; a path outside the project is refused', async () => {
    const sandbox = fakeSandbox({ reply: { report: report('erc-ldo-led.json') } });
    assert.equal((await checker(sandbox).check('erc', {}, {})).unavailable, true, 'no project folder');
    const noBoard = await checker(sandbox).check('drc', {}, ctxFor('ldo-led-faulty'));
    assert.deepEqual([noBoard.ok, noBoard.unavailable], [true, true]);
    assert.match(noBoard.detail, /no \.kicad_pcb/);
    await assert.rejects(checker(sandbox).check('erc', { output: { schematic: '../ldo-led/ldo-led.kicad_sch' } }, ctxFor('ldo-led-faulty')), (err) => err.code === 'path_escapes');
    assert.equal(sandbox.calls.length, 0);
  });
});
