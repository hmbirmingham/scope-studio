import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_OUTPUT, RUN_TIMEOUT_MS, declaredScripts, execute } from '../../editing/commands.js';
import { runSandboxed, sandboxStatus } from '../../workspace/sandbox/run.js';
import { CodeError, checkoutRoot } from './paths.js';

// Declared scripts are the project's own code, the same thing a user approves
// at /api/runs today. In a sandbox they run inside the OS sandbox when one is
// available (no network, nothing outside the sandbox copy writable); without
// an OS sandbox they still run only in the sandbox copy, never on a string a
// model wrote.

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

export async function runDeclaredScript(ctx, script) {
  const root = checkoutRoot(ctx);
  const scripts = await projectScripts(root);
  if (!scripts.includes(script)) {
    throw new CodeError('undeclared_script', `the project does not declare a "${script}" script`, { available: scripts });
  }

  if (ctx.sandbox?.worktree && (await sandboxStatus()).available) {
    const result = await runSandboxed({
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
