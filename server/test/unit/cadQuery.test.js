import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createCadQuery } from '../../src/plugins/cad/cadquery.js';
import { removeTempDirs, useDataDir } from '../integration/workspaceSandboxFixtures.js';

// The CadQuery runner with a scripted OS sandbox: what it asks the sandbox
// for, how it reads the driver's answer, and every way a run can fail.
// Nothing here starts a process.

const MARKER = '@@SCOPE_CAD@@';
const answer = (payload) => `noise from a library\n${MARKER}${JSON.stringify(payload)}\n`;

let data;
before(() => {
  data = useDataDir();
});
after(() => {
  data.restore();
  removeTempDirs();
});

// A sandbox whose run() calls `reply(options, request)` and returns its
// result; `status` defaults to available.
function scripted(reply, status = { available: true, mechanism: 'test', reason: null }) {
  const calls = [];
  return {
    calls,
    async status() {
      return status;
    },
    async run(options) {
      const request = JSON.parse(readFileSync(options.args.at(-1), 'utf8'));
      calls.push({ options, request, cwdExisted: existsSync(options.cwd) });
      const result = await reply(options, request);
      return { ok: true, exitCode: 0, signal: null, timedOut: false, limit: null, truncated: false, durationMs: 1, mechanism: 'test', ...result };
    },
  };
}

const probeOk = (options, request) => (request.mode === 'probe' ? { output: answer({ version: '9.9' }) } : null);

describe('CadQuery availability', () => {
  test('no OS sandbox means no CadQuery, and nothing is started', async () => {
    const sandbox = scripted(() => {
      throw new Error('must not run');
    }, { available: false, reason: 'missing bwrap' });
    const state = await createCadQuery({ sandbox }).status();
    assert.equal(state.available, false);
    assert.match(state.reason, /no OS sandbox \(missing bwrap\)/);
    assert.equal(sandbox.calls.length, 0);
  });

  test('a Python without CadQuery is reported as such', async () => {
    const sandbox = scripted(() => ({ ok: false, exitCode: 1, output: answer({ error: { code: 'cadquery_missing', message: "CadQuery could not be imported: No module named 'cadquery'" } }) }));
    const state = await createCadQuery({ sandbox }).status();
    assert.equal(state.available, false);
    assert.match(state.reason, /No module named 'cadquery'/);
  });

  test('an interpreter that is not installed is reported, not thrown', async () => {
    const sandbox = scripted(() => {
      throw Object.assign(new Error('/opt/none/python3 is not installed'), { code: 'command_not_found' });
    });
    const state = await createCadQuery({ sandbox, python: () => '/opt/none/python3' }).status();
    assert.equal(state.available, false);
    assert.match(state.reason, /CadQuery cannot run here: \/opt\/none\/python3 is not installed/);
  });

  test('a success is kept; a failure is asked again after a while', async () => {
    let clock = 0;
    let installed = false;
    const sandbox = scripted(() => (installed ? { output: answer({ version: '2.8.0' }) } : { ok: false, exitCode: 1, output: answer({ error: { code: 'cadquery_missing', message: 'no cadquery' } }) }));
    const cadquery = createCadQuery({ sandbox, now: () => clock, retryFailedMs: 1000 });
    assert.equal((await cadquery.status()).available, false);
    installed = true;
    clock = 500;
    assert.equal((await cadquery.status()).available, false, 'still the cached failure');
    clock = 1500;
    assert.deepEqual(await cadquery.status(), { available: true, version: '2.8.0', reason: null });
    const probes = sandbox.calls.length;
    clock = 1e9;
    await cadquery.status();
    assert.equal(sandbox.calls.length, probes, 'a success is not probed again');
  });

  test('every call refuses with tool_unavailable when CadQuery cannot run', async () => {
    const cadquery = createCadQuery({ sandbox: scripted(() => ({}), { available: false, reason: 'none' }) });
    await assert.rejects(cadquery.inspect([{ name: 'a.step', buffer: Buffer.from('x') }]), (err) => err.code === 'tool_unavailable');
    await assert.rejects(cadquery.interference([{ name: 'a.step', buffer: Buffer.from('x') }]), (err) => err.code === 'tool_unavailable');
    await assert.rejects(cadquery.edit({ script: 'result = 1', output: 'result.step' }), (err) => err.code === 'tool_unavailable');
  });
});

describe('a CadQuery run', () => {
  test('runs the driver isolated in a fresh scratch directory, with limits, and removes it', async () => {
    const sandbox = scripted((options, request) => probeOk(options, request) ?? { output: answer({ files: [{ name: 'parts/a b.step', volume: 1 }] }) });
    const cadquery = createCadQuery({ sandbox });
    const [info] = await cadquery.inspect([{ name: 'parts/a b.step', buffer: Buffer.from('ISO-10303-21;') }]);
    assert.equal(info.volume, 1);
    const { options, request, cwdExisted } = sandbox.calls.at(-1);
    assert.equal(options.args[0], '-I', 'isolated mode: the scratch directory is not on sys.path');
    assert.match(options.args[1], /driver\.py$/);
    assert.deepEqual(options.writable, [options.cwd], 'only its own directory is writable');
    assert.ok(options.memoryMb > 0 && options.cpuSeconds > 0 && options.timeoutMs > 0);
    assert.ok(cwdExisted);
    assert.equal(request.inputs[0].name, 'parts/a b.step');
    assert.match(request.inputs[0].path, /\/in\/0-a_b\.step$/, 'copied in under a safe name, keeping the extension');
    assert.ok(!existsSync(options.cwd), 'the scratch directory is removed afterwards');
  });

  test('timeouts, limits, missing answers and driver errors each fail with their own code', async () => {
    const cases = [
      [{ ok: false, exitCode: null, timedOut: true, output: '' }, 'cadquery_timeout'],
      [{ ok: false, exitCode: 152, limit: 'cpu', output: '' }, 'cadquery_limit'],
      [{ ok: false, exitCode: 139, output: 'Segmentation fault' }, 'cadquery_failed'],
      [{ ok: false, exitCode: 1, output: answer({ error: { code: 'cadquery_error', message: 'Traceback: StdFail_NotDone' } }) }, 'cadquery_error'],
      [{ ok: true, output: `${MARKER}{not json` }, 'cadquery_failed'],
    ];
    for (const [result, code] of cases) {
      const cadquery = createCadQuery({ sandbox: scripted((options, request) => probeOk(options, request) ?? result) });
      await assert.rejects(cadquery.interference([{ name: 'a.step', buffer: Buffer.from('x') }]), (err) => err.code === code, code);
    }
  });

  test('a sandbox that disappears mid-call is tool_unavailable, never a host run', async () => {
    let probed = false;
    const sandbox = scripted((options, request) => {
      if (request.mode === 'probe') {
        probed = true;
        return { output: answer({ version: '1' }) };
      }
      throw Object.assign(new Error('no OS sandbox is available'), { code: 'sandbox_unavailable' });
    });
    await assert.rejects(createCadQuery({ sandbox }).inspect([{ name: 'a.step', buffer: Buffer.from('x') }]), (err) => err.code === 'tool_unavailable');
    assert.ok(probed);
  });

  test('an edit hands the script over and returns the exported file and its mesh', async () => {
    let seenScript = null;
    const good = scripted((options, request) => {
      if (request.mode === 'probe') return { output: answer({ version: '1' }) };
      seenScript = readFileSync(request.script, 'utf8');
      writeFileSync(request.output, 'ISO-10303-21;');
      writeFileSync(join(options.cwd, 'out', 'mesh-result.stl'), 'solid x\nendsolid x\n');
      return { output: answer({ valid: true, solids: 1 }) };
    });
    const edited = await createCadQuery({ sandbox: good }).edit({ script: 'result = cq.Workplane().box(1, 1, 1)', output: 'result.step' });
    assert.equal(seenScript, 'result = cq.Workplane().box(1, 1, 1)');
    assert.equal(good.calls.at(-1).request.output.endsWith('/out/result.step'), true);
    assert.equal(edited.file.toString(), 'ISO-10303-21;');
    assert.match(edited.mesh.toString(), /^solid/);
    assert.deepEqual(edited.info, { valid: true, solids: 1 });
  });

  test('a link planted where the exported file should be is not followed', async () => {
    const outside = join(data.dir, 'host-secret.txt');
    writeFileSync(outside, 'not for the sandbox');
    const planted = scripted((options, request) => {
      if (request.mode === 'probe') return { output: answer({ version: '1' }) };
      mkdirSync(join(options.cwd, 'out'), { recursive: true });
      symlinkSync(outside, request.output);
      return { output: answer({ valid: true, solids: 1 }) };
    });
    await assert.rejects(createCadQuery({ sandbox: planted }).edit({ script: 'result = 1', output: 'result.step' }), (err) => err.code === 'no_result');
  });
});
