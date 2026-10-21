import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { SandboxError } from './run.js';
import { assertSafeSandboxDir, isInside, realpathLoose, sandboxesDir } from './paths.js';

// A run's sandbox: a private copy of the project made from its HEAD (plus,
// optionally, the user's uncommitted changes), in the app data directory.
//
//   <data>/sandboxes/<runId>/
//     git/       the repository database; never mounted into the OS sandbox
//     worktree/  the checkout agents read, edit and run declared scripts in
//     scratch/   where generated code is written and run
//
// It is an independent clone rather than a `git worktree` of the user's
// repository: a linked worktree shares the user's .git directory (its refs,
// config and hooks), so anything written in the sandbox could reach the
// user's repository. The clone copies objects without hard links, so nothing
// in the sandbox shares an inode with the user's checkout.
//
// The git directory lives beside the worktree, not inside it, and the host
// only ever runs git with an explicit --git-dir. Code in the OS sandbox can
// write anything in worktree/, including a forged `.git` file or
// `.gitattributes`, but cannot reach the config that decides which hooks,
// filters or fsmonitor commands git would run on the host.

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
// Untracked files are carried only when they are small enough to be source.
const MAX_UNTRACKED_FILES = 2_000;
const MAX_UNTRACKED_BYTES = 1024 * 1024;

function git(args, { cwd, maxBuffer = GIT_MAX_BUFFER, encoding = 'utf8' } = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer,
        encoding,
        timeout: GIT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
      },
      (err, stdout, stderr) => {
        if (err) {
          const failure = new SandboxError('git_failed', `git ${args.find((arg) => !arg.startsWith('-')) ?? ''} failed: ${String(stderr || err.message).trim().slice(0, 500)}`);
          failure.exitCode = typeof err.code === 'number' ? err.code : null;
          failure.stdout = stdout;
          reject(failure);
        } else resolvePromise(stdout);
      }
    );
  });
}

// Config that keeps host-side git from running anything a repository could
// configure. The sandbox's config is ours, but this also covers the user's
// repository while it is being copied.
const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'safe.directory=*'];

// Runs git against a sandbox on the host, always naming its git directory and
// worktree explicitly so nothing written inside the worktree can redirect it.
export function sandboxGit(sandbox, args, options = {}) {
  if (!sandbox?.gitDir || !sandbox?.worktree) throw new SandboxError('no_sandbox', 'this sandbox has no checkout');
  return git([...SAFE_GIT, '--git-dir', sandbox.gitDir, '--work-tree', sandbox.worktree, ...args], { cwd: sandbox.worktree, ...options });
}

function checkRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new SandboxError('invalid_sandbox_request', 'a sandbox needs a simple run id');
}

async function makeRoot(runId, { repoPath, env } = {}) {
  checkRunId(runId);
  const base = sandboxesDir({ env });
  const root = join(base, runId);
  assertSafeSandboxDir(root, { repoPath });
  await mkdir(base, { recursive: true, mode: 0o700 });
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (err) {
    if (err.code === 'EEXIST') throw new SandboxError('sandbox_exists', `a sandbox for run ${runId} already exists`);
    throw err;
  }
  // Re-check with the directory in place, in case a parent was a symlink.
  assertSafeSandboxDir(root, { repoPath });
  return realpathLoose(root);
}

async function makeWritable(path) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;
  // Code in the sandbox can chmod its own directories to 000; the owner can
  // still restore the mode, which removal needs.
  await chmod(path, 0o700).catch(() => {});
  for (const entry of await readdir(path).catch(() => [])) await makeWritable(join(path, entry));
}

// Removes a sandbox completely. Refuses anything that is not a sandbox
// directory, so a corrupted record can never delete something else.
export async function removeSandbox(sandbox, { env } = {}) {
  const root = typeof sandbox === 'string' ? sandbox : sandbox?.root;
  if (!root) return;
  const base = realpathLoose(sandboxesDir({ env }));
  const real = realpathLoose(root);
  if (dirname(real) !== base || !RUN_ID.test(basename(real))) {
    throw new SandboxError('unsafe_sandbox_path', `${root} is not a sandbox directory`);
  }
  await makeWritable(real);
  await rm(real, { recursive: true, force: true, maxRetries: 3 });
}

async function carryUntracked(repo, worktree) {
  const listing = await git([...SAFE_GIT, '-C', repo, 'ls-files', '--others', '--exclude-standard', '-z']);
  const files = listing.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED_FILES);
  let carried = 0;
  for (const file of files) {
    const source = join(repo, file);
    const target = join(worktree, file);
    // Only regular files, never symlinks, and only paths that stay inside.
    if (!isInside(worktree, target)) continue;
    const stat = await lstat(source).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_UNTRACKED_BYTES) continue;
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    carried += 1;
  }
  return carried;
}

// createSandbox({ runId, repoPath, carryUncommitted }) → { id, root, gitDir,
// worktree, scratch, head, carried }. On any failure the directory is removed
// before the error is thrown.
export async function createSandbox({ runId, repoPath, carryUncommitted = false, env } = {}) {
  if (typeof repoPath !== 'string' || !repoPath) throw new SandboxError('invalid_sandbox_request', 'a sandbox needs the project checkout');
  let repo;
  try {
    repo = (await git([...SAFE_GIT, '-C', repoPath, 'rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new SandboxError('not_a_repository', `${repoPath} is not a git checkout`);
  }
  const head = (await git([...SAFE_GIT, '-C', repo, 'rev-parse', '--verify', 'HEAD^{commit}']).catch(() => {
    throw new SandboxError('no_commits', `${repo} has no commit to start from`);
  })).trim();

  const root = await makeRoot(runId, { repoPath: repo, env });
  const sandbox = {
    id: runId,
    root,
    gitDir: join(root, 'git'),
    worktree: join(root, 'worktree'),
    scratch: join(root, 'scratch'),
    head,
    carried: { diff: false, untracked: 0 },
  };
  try {
    // A local clone copies the whole object database, so HEAD is present
    // even when the user is on a detached commit. An empty template keeps
    // git's sample hooks out of the copy.
    await git([...SAFE_GIT, 'clone', '--quiet', '--no-checkout', '--no-hardlinks', '--template=', `--separate-git-dir=${sandbox.gitDir}`, '--', repo, sandbox.worktree]);
    await sandboxGit(sandbox, ['remote', 'remove', 'origin']);
    await sandboxGit(sandbox, ['checkout', '--quiet', '-b', `scope/${runId}`, head]);
    await mkdir(sandbox.scratch);

    if (carryUncommitted) {
      const diff = await git([...SAFE_GIT, '-C', repo, 'diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD'], { encoding: 'buffer' });
      if (diff.length) {
        const patch = join(root, `carry-${randomUUID()}.patch`);
        await writeFile(patch, diff);
        try {
          await sandboxGit(sandbox, ['apply', '--whitespace=nowarn', '--binary', patch]);
        } finally {
          await rm(patch, { force: true });
        }
        sandbox.carried.diff = true;
      }
      sandbox.carried.untracked = await carryUntracked(repo, sandbox.worktree);
    }
    return sandbox;
  } catch (err) {
    await removeSandbox(root, { env }).catch(() => {});
    throw err;
  }
}

// A sandbox with only a scratch directory, for generated code that does not
// need the project.
export async function createScratchSandbox({ runId = randomUUID(), env } = {}) {
  const root = await makeRoot(runId, { env });
  const sandbox = { id: runId, root, gitDir: null, worktree: null, scratch: join(root, 'scratch'), head: null, carried: null };
  try {
    await mkdir(sandbox.scratch);
    return sandbox;
  } catch (err) {
    await removeSandbox(root, { env }).catch(() => {});
    throw err;
  }
}

// Creates a sandbox, hands it to `fn`, and removes it however `fn` ends.
export async function withSandbox(options, fn) {
  const sandbox = options?.repoPath ? await createSandbox(options) : await createScratchSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    await removeSandbox(sandbox, { env: options?.env });
  }
}
