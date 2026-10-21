import { execFile } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { checkCadResult } from '../../plugins/cad/check.js';
import { runSandboxed, sandboxStatus } from '../../workspace/sandbox/index.js';
import { fixturePath } from './catalog.js';

// The benchmark's own files on disk: a throwaway directory per run holding
// each task's project (a git repository made from the fixture, which is what
// the runner's sandbox copies), the sandboxes themselves, and the snapshots
// the objective check runs against. Nothing here is the user's.

const GIT_TIMEOUT_MS = 30_000;
// The fixtures are tiny; this bounds a check that hangs on a broken result.
const CHECK_TIMEOUT_MS = 60_000;
const CHECK_OUTPUT_CHARS = 4_000;

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        // A fixed identity: the fixture commit is the benchmark's, never the
        // person running it, and must not depend on their git config.
        env: {
          ...process.env,
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_AUTHOR_NAME: 'Scope task benchmark',
          GIT_AUTHOR_EMAIL: 'benchmark@example.invalid',
          GIT_COMMITTER_NAME: 'Scope task benchmark',
          GIT_COMMITTER_EMAIL: 'benchmark@example.invalid',
        },
      },
      (err, stdout, stderr) => (err ? reject(new Error(`git ${args[0]} failed: ${String(stderr || err.message).trim()}`)) : resolve(stdout))
    );
  });
}

// A scratch root for one benchmark run. `dataDir` is where the runner's
// sandboxes go (passed to it as SCOPE_DATA_DIR), so a crashed run never
// leaves sandboxes in the user's app data.
export function createWorkspace({ parent = tmpdir() } = {}) {
  const root = mkdtempSync(join(parent, 'scope-task-benchmark-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  return {
    root,
    dataDir,
    sandboxEnv: { SCOPE_DATA_DIR: dataDir },
    dir(...parts) {
      const path = join(root, ...parts);
      mkdirSync(path, { recursive: true });
      return path;
    },
    remove() {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

// The task's project as a fresh git repository with one commit: what an
// arm's sandbox is made from, and what the check restores tests from.
export async function prepareProject(task, workspace, arm) {
  const repo = workspace.dir('projects', task.id, arm);
  cpSync(fixturePath(task), repo, { recursive: true });
  await git(repo, ['init', '--quiet', '--initial-branch=main']);
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '--quiet', '--no-gpg-sign', '-m', `fixture ${task.fixture}`]);
  return repo;
}

// Copies a worktree's files (never its .git link) somewhere the check can
// run them. Synchronous on purpose: the Scope arm calls it from the run's
// `run.finished` event, which the worker publishes before it removes the
// sandbox.
export function snapshotTree(from, to) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !relative(from, source).split(sep).includes('.git'),
  });
  return to;
}

// Every file under `path` (itself, if it is a file), relative to `root`.
function listFiles(root, path) {
  const abs = join(root, path);
  const stat = lstatSync(abs, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory()) return [path];
  return readdirSync(abs).flatMap((entry) => listFiles(root, join(path, entry))).sort();
}

// Whether `paths` (files or directories, relative) differ between two trees.
export function treesDiffer(a, b, paths) {
  for (const path of paths) {
    const left = listFiles(a, path);
    const right = listFiles(b, path);
    if (left.join('\0') !== right.join('\0')) return true;
    for (const file of left) {
      if (!readFileSync(join(a, file)).equals(readFileSync(join(b, file)))) return true;
    }
  }
  return false;
}

export async function osSandboxStatus() {
  try {
    return await sandboxStatus();
  } catch (err) {
    return { available: false, reason: err?.message ?? 'the sandbox probe failed' };
  }
}

// The objective check. The result's files are copied, the fixture's tests
// and package.json are put back over them, and the task's script runs in the
// OS sandbox (the result may hold model-written code). Completed means that
// script exited 0; nothing a model reported is consulted.
export async function objectiveCheck(task, { resultDir, workspace, label, sandbox = { run: runSandboxed } }) {
  // A CAD task's check measures the part the run left; it reads the file
  // and runs nothing from the result.
  if (task.check.kind === 'cad') {
    const result = await checkCadResult({ dir: resultDir && existsSync(resultDir) ? resultDir : null, check: task.check });
    return { completed: result.completed, exitCode: null, timedOut: false, testsTampered: false, output: result.output.slice(0, CHECK_OUTPUT_CHARS) };
  }
  const dir = workspace.dir('checks', task.id, label);
  rmSync(dir, { recursive: true, force: true });
  if (resultDir && existsSync(resultDir)) snapshotTree(resultDir, dir);
  else snapshotTree(fixturePath(task), dir);
  const restore = task.check.restore ?? [];
  const tampered = resultDir && existsSync(resultDir) ? treesDiffer(resultDir, fixturePath(task), restore) : false;
  for (const path of restore) {
    rmSync(join(dir, path), { recursive: true, force: true });
    if (existsSync(join(fixturePath(task), path))) cpSync(join(fixturePath(task), path), join(dir, path), { recursive: true });
  }
  const result = await sandbox.run({
    command: 'npm',
    args: ['run', '--silent', task.check.script],
    cwd: dir,
    writable: [dir],
    timeoutMs: CHECK_TIMEOUT_MS,
    memoryMb: 1024,
    cpuSeconds: 60,
    maxOutput: CHECK_OUTPUT_CHARS * 4,
  });
  const output = String(result.output ?? '');
  return {
    completed: result.ok === true,
    exitCode: result.exitCode ?? null,
    timedOut: Boolean(result.timedOut),
    testsTampered: tampered,
    output: output.length > CHECK_OUTPUT_CHARS ? `…${output.slice(-CHECK_OUTPUT_CHARS)}` : output,
  };
}
