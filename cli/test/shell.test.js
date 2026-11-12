import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../src/runners/shell.js';
import { Refused } from '../src/core/consent.js';
import { proposalBudget } from '../src/core/consent.js';

// The suite runs with stdin not a terminal, which is the point: anything that
// needs asking must refuse here rather than proceed. That is the property the
// whole gate rests on — an unattended run is not a reason to assume consent.
const ctx = { workspace: process.cwd(), protectedPaths: ['cli/test'] };

test('an auto-approved read runs with no prompt, even with nobody to ask', async () => {
  const r = await runCommand({ command: 'git', args: ['rev-parse', '--abbrev-ref', 'HEAD'], readOnly: true }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.approved, 'auto');
  assert.ok(r.stdout.trim().length > 0);
});

test('anything needing approval refuses when stdin is not a terminal', async () => {
  // The tempting alternative — proceed because the user set the run up and
  // must have meant it — is exactly how an approval gate becomes decoration.
  await assert.rejects(
    () => runCommand({ command: 'make', args: ['--version'] }, ctx),
    (err) => err instanceof Refused && /not a terminal/.test(err.message)
  );
});

test('a read-only label does not get a command past the allowlist', async () => {
  await assert.rejects(
    () => runCommand({ command: 'rm', args: ['-rf', '/tmp/nope'], readOnly: true }, ctx),
    (err) => err instanceof Refused && /not a terminal/.test(err.message),
    'rm claimed read-only must still reach the prompt, not the allowlist'
  );
});

test('an escape flag drops a read out of auto and into the prompt', async () => {
  await assert.rejects(
    () => runCommand({ command: 'git', args: ['log', '-c', 'core.pager=sh -c id', '-1'], readOnly: true }, ctx),
    (err) => err instanceof Refused
  );
});

test('a non-zero exit is a result, not a throw', async () => {
  // "The tests failed" is what a gate needs to read. Throwing on it would make
  // a failing suite indistinguishable from a broken runner.
  const r = await runCommand(
    { command: 'git', args: ['rev-parse', '--verify', 'refs/heads/definitely-not-a-branch'], readOnly: true },
    ctx
  );
  assert.equal(r.ok, false);
  assert.ok(r.code !== 0);
});

test('a refused command does not spend the proposal budget twice', async () => {
  const budget = proposalBudget(1);
  await assert.rejects(() => runCommand({ command: 'make', args: [] }, { ...ctx, budget }));
  assert.equal(budget.used, 1);
});

test('cwd is pinned to the workspace, not inherited', async () => {
  const r = await runCommand({ command: 'git', args: ['rev-parse', '--show-toplevel'], readOnly: true }, ctx);
  assert.equal(r.stdout.trim(), process.cwd().replace(/\/$/, ''));
});
