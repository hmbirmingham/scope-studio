import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { commitVault, vaultIsGit, writeNote } from '../src/core/vault.js';

const run = promisify(execFile);

async function tempVault({ git }) {
  const vault = await mkdtemp(join(tmpdir(), 'scope-commit-'));
  if (git) {
    await run('git', ['-C', vault, 'init', '-q']);
    await run('git', ['-C', vault, 'config', 'user.email', 't@t.t']);
    await run('git', ['-C', vault, 'config', 'user.name', 'T']);
    await run('git', ['-C', vault, 'commit', '-q', '--allow-empty', '-m', 'baseline']);
  }
  return { vault, agentPrefix: 'scope' };
}

test('commitVault commits agent writes so they can be reverted', async () => {
  const config = await tempVault({ git: true });
  await writeNote(config, 'runs/r1.md', { fields: { id: 'r1' }, body: 'trace' });
  const result = await commitVault(config, 'scope: run r1 (passed)');
  assert.deepEqual(result, { committed: true });
  const { stdout } = await run('git', ['-C', config.vault, 'log', '--oneline', '-1']);
  assert.match(stdout, /scope: run r1 \(passed\)/);
});

test('commitVault leaves notes outside the agent area uncommitted', async () => {
  const config = await tempVault({ git: true });
  await mkdir(join(config.vault, 'personal'), { recursive: true });
  await writeFile(join(config.vault, 'personal', 'diary.md'), 'mine', 'utf8');
  await writeNote(config, 'runs/r2.md', { fields: { id: 'r2' }, body: 'trace' });
  await commitVault(config, 'scope: run r2');
  const { stdout } = await run('git', ['-C', config.vault, 'status', '--porcelain', '-uall']);
  assert.match(stdout, /personal\/diary\.md/, 'the human’s own file stays untracked');
  const { stdout: show } = await run('git', ['-C', config.vault, 'show', '--name-only', '--format=', 'HEAD']);
  assert.equal(show.trim(), 'scope/runs/r2.md');
});

test('commitVault reports rather than throws when the vault is not a git repo', async () => {
  const config = await tempVault({ git: false });
  assert.equal(await vaultIsGit(config), false);
  const result = await commitVault(config, 'scope: run r3');
  assert.equal(result.committed, false);
  assert.match(result.reason, /not a git repo/);
});

test('commitVault reports nothing-to-commit instead of claiming success', async () => {
  const config = await tempVault({ git: true });
  const result = await commitVault(config, 'scope: empty');
  assert.deepEqual(result, { committed: false, reason: 'nothing to commit' });
});
