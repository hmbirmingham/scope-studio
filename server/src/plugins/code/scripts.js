import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_OUTPUT, RUN_TIMEOUT_MS, declaredScripts, execute } from '../../editing/commands.js';
import { runSandboxed, sandboxStatus } from '../../workspace/sandbox/run.js';
import { CodeError, checkoutRoot } from './paths.js';

// Declared scripts are the project's own code, the same thing a user approves
// at /api/runs today, and in the user's checkout (a run with no sandbox copy)
// they run the same way /api/runs does. A sandbox copy is different: code.edit
// can rewrite package.json, the tests and the sources there, so a declared
// script in the copy is model-written code. It runs only inside the OS
// sandbox (no network, nothing outside the copy writable), and without one it
// is refused with `sandbox_unavailable`, never run on the host.

// The OS sandbox the default plug-in uses; tests pass their own.
export const defaultSandbox = Object.freeze({ status: sandboxStatus, run: runSandboxed });

// npm init's placeholder is "declared" but is not a test suite.
const PLACEHOLDER = /no test specified/i;

const SCRIPT_LIMITS = {
  timeoutMs: RUN_TIMEOUT_MS,
  memoryMb: 2048,
  cpuSeconds: 300,
  maxProcesses: 256,
  maxFileMb: 256,
  maxOutput: MAX_OUTPUT,
};

export async function projectScripts(root) {
  const names = await declaredScripts(root);
  let bodies = {};
  try {
    bodies = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    // declaredScripts already treats an unreadable manifest as no scripts.
  }
  return names.filter((name) => typeof bodies[name] === 'string' && !PLACEHOLDER.test(bodies[name]));
}

export async function runDeclaredScript(ctx, script, sandbox = defaultSandbox) {
  const root = checkoutRoot(ctx);
  const scripts = await projectScripts(root);
  if (!scripts.includes(script)) {
    throw new CodeError('undeclared_script', `the project does not declare a "${script}" script`, { available: scripts });
  }

  if (ctx.sandbox?.worktree) {
    const state = await probeSandbox(sandbox);
    if (!state.available) {
      throw new CodeError('sandbox_unavailable', `no OS sandbox is available (${state.reason}); refusing to run "${script}" in the sandbox copy unsandboxed`);
    }
    const result = await sandbox.run({
      command: 'npm',
      args: ['run', '--silent', script],
      cwd: root,
      writable: [root],
      protect: ctx.localPath ? [ctx.localPath] : [],
      signal: ctx.signal,
      ...SCRIPT_LIMITS,
    });
    return {
      script,
      exitCode: result.exitCode,
      ok: result.ok,
      output: result.output,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      limit: result.limit,
      sandboxed: true,
    };
  }

  // The user's own checkout, which no capability edits.
  const result = await execute({ cwd: root, script });
  return {
    script,
    exitCode: result.exitCode,
    ok: result.exitCode === 0 && !result.timedOut,
    output: result.output,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    limit: result.timedOut ? 'timeout' : null,
    sandboxed: false,
  };
}

async function probeSandbox(sandbox) {
  try {
    return await sandbox.status();
  } catch (err) {
    return { available: false, reason: err?.message ?? 'the sandbox probe failed' };
  }
}
