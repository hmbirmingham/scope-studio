import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Throwaway directories and git repositories for the sandbox and code
// plug-in tests. Everything lives under the system temp directory and is
// removed by the returned cleanup.

export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `scope-${prefix}-`));
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

export function makeRepo(files, { parent = tempDir('repo') } = {}) {
  const repo = join(parent, 'project');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '--quiet', '--initial-branch=main']);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '--no-gpg-sign', '-m', 'initial']);
  return { repo, parent, git: (args) => git(repo, args), cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

// Points the sandbox data directory at a fresh temp directory for one test
// file and restores the previous value afterwards.
export function useDataDir() {
  const previous = process.env.SCOPE_DATA_DIR;
  const dir = tempDir('data');
  process.env.SCOPE_DATA_DIR = dir;
  return {
    dir,
    restore() {
      if (previous === undefined) delete process.env.SCOPE_DATA_DIR;
      else process.env.SCOPE_DATA_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The pids of live processes whose command line contains `marker`.
export function processesWith(marker) {
  const found = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(marker)) found.push(Number(entry));
    } catch {
      // The process exited while we looked.
    }
  }
  return found;
}
