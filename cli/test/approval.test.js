import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO, ASK, REFUSE, classify, withinWorkspace } from '../src/core/approval.js';
import { proposalBudget } from '../src/core/consent.js';

const ctx = { workspace: '/Users/x/repo', protectedPaths: ['tb', 'golden'] };

test('an unknown action kind is refused, not passed through to ask', () => {
  // Fail closed, like an unknown gate check. Naming a kind means the policy was
  // thought about; an unnamed kind has not been, and routing it to `ask` would
  // look safe while being a hole.
  for (const kind of [undefined, 'teleport', 'eval', '']) {
    assert.equal(classify({ kind }, ctx).decision, REFUSE, `kind ${JSON.stringify(kind)}`);
  }
  assert.equal(classify(null, ctx).decision, REFUSE);
});

test('read-only git subcommands run without asking', () => {
  for (const sub of ['status', 'diff', 'log', 'rev-parse']) {
    assert.equal(classify({ kind: 'read_command', command: 'git', args: [sub] }, ctx).decision, AUTO, sub);
  }
});

test('a state-changing git subcommand is not read-only however it is labelled', () => {
  for (const sub of ['commit', 'push', 'checkout', 'reset', 'clean']) {
    const v = classify({ kind: 'read_command', command: 'git', args: [sub] }, ctx);
    assert.equal(v.decision, ASK, sub);
  }
});

test('escape flags defeat the read-only claim', () => {
  // `git` is read-only until you hand it the right flag: --ext-diff runs an
  // external diff program, -c sets config (including the pager) for one
  // invocation, --exec-path relocates the helpers, --output writes a file.
  // Each would turn an auto-approved read into arbitrary execution.
  const attempts = [
    ['log', '--ext-diff'],
    ['log', '-c', 'core.pager=sh -c id'],
    ['diff', '--output=/tmp/pwned'],
    ['diff', '--output', '/tmp/pwned'],
    ['status', '--exec-path=/tmp/evil'],
    ['ls-files', '--git-dir=/elsewhere/.git'],
  ];
  for (const args of attempts) {
    const v = classify({ kind: 'read_command', command: 'git', args }, ctx);
    assert.equal(v.decision, ASK, args.join(' '));
    assert.deepEqual(v.flags, ['escape_flag'], args.join(' '));
  }
});

test('a command not on the allowlist asks even when the caller calls it read-only', () => {
  for (const command of ['make', 'cat', 'python3', 'node', 'rm']) {
    assert.equal(classify({ kind: 'read_command', command, args: ['--version'] }, ctx).decision, ASK, command);
  }
});

test('nothing is auto-approved when no workspace is bound', () => {
  // Without a workspace there is nothing provably contained to read inside of.
  const v = classify({ kind: 'read_command', command: 'git', args: ['status'] }, {});
  assert.equal(v.decision, ASK);
  assert.match(v.reason, /no workspace/);
});

test('reading inside the workspace is free; outside it asks', () => {
  assert.equal(classify({ kind: 'read_file', path: 'rtl/pe.sv' }, ctx).decision, AUTO);
  for (const path of ['../other/secrets', '/etc/passwd', '../../.ssh/id_rsa']) {
    assert.equal(classify({ kind: 'read_file', path }, ctx).decision, ASK, path);
  }
});

test('every file write asks, inside the workspace or not', () => {
  const inside = classify({ kind: 'write_file', path: 'rtl/pe.sv' }, ctx);
  assert.equal(inside.decision, ASK);
  assert.ok(!inside.irreversible, 'a write on a tracked branch has a git undo');

  const outside = classify({ kind: 'write_file', path: '/etc/hosts' }, ctx);
  assert.equal(outside.decision, ASK);
  assert.equal(outside.irreversible, true, 'no git undo exists outside the workspace');
  assert.ok(outside.flags.includes('outside_workspace'));
});

test('a write to the test oracle is flagged', () => {
  // The cheapest way to pass "the tests pass" is to change the tests, so this
  // has to be visible at the moment of approval rather than only in a gate.
  for (const path of ['tb/pe/test_pe.py', 'golden/pe_model.py']) {
    const v = classify({ kind: 'write_file', path }, ctx);
    assert.equal(v.decision, ASK);
    assert.ok(v.flags.includes('test_oracle'), path);
  }
  assert.ok(!classify({ kind: 'write_file', path: 'rtl/pe.sv' }, ctx).flags.includes('test_oracle'));
  // A path that merely starts with the same letters is not inside it.
  assert.ok(!classify({ kind: 'write_file', path: 'tbx/other.sv' }, ctx).flags.includes('test_oracle'));
});

test('executing anything asks, including a project-declared script', () => {
  // A Makefile runs arbitrary code. "The project declared it" is a reason to
  // allow it to exist, not a reason to skip the prompt.
  const v = classify({ kind: 'shell', command: 'make', args: ['-C', 'tb/pe'] }, ctx);
  assert.equal(v.decision, ASK);
});

test('screen and network actions are always irreversible', () => {
  // There is no undo for a click or for a sent request, which is the reason
  // this gate is shaped for them rather than for file edits.
  assert.deepEqual(
    ['screen', 'network'].map((kind) => classify({ kind }, ctx).irreversible),
    [true, true]
  );
});

test('withinWorkspace refuses traversal', () => {
  assert.equal(withinWorkspace('/a/b', 'c/d'), true);
  assert.equal(withinWorkspace('/a/b', '../c'), false);
  assert.equal(withinWorkspace('/a/b', '/a/c'), false);
  assert.equal(withinWorkspace(null, 'c'), false);
});

test('the proposal budget stops a run that would grind you down', () => {
  const budget = proposalBudget(3);
  budget.spend();
  budget.spend();
  budget.spend();
  assert.throws(() => budget.spend(), /more than 3 approvals/);
});
