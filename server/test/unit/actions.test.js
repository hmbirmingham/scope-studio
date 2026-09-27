import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import { SEARCH_URL, autoOpens, executeAction, parseActions, planAction, recordActions } from '../../src/editing/actions.js';

describe('parseActions', () => {
  test('reads each kind once, trimmed, and ignores anything else', () => {
    const answer = [
      'Here you go.',
      '<open kind="search"> pgvector hnsw tuning </open>',
      '<open kind="url">https://github.com/pgvector/pgvector</open>',
      '<open kind="search">pgvector hnsw tuning</open>',
      '<open kind="shell">rm -rf /</open>',
      '<open kind="app">Safari</open>',
    ].join('\n');
    assert.deepEqual(parseActions(answer), [
      { kind: 'search', target: 'pgvector hnsw tuning' },
      { kind: 'url', target: 'https://github.com/pgvector/pgvector' },
      { kind: 'app', target: 'Safari' },
    ]);
  });
});

describe('planAction', () => {
  test('a search opens the search engine with the query encoded', async () => {
    const plan = await planAction({ kind: 'search', target: 'a & b?' });
    assert.deepEqual(plan.args, ['-u', `${SEARCH_URL}a%20%26%20b%3F`]);
    assert.match((await planAction({ kind: 'search', target: 'x'.repeat(201) })).problem, /1–200/);
  });

  test('only http and https addresses open, and never with a login in them', async () => {
    assert.deepEqual((await planAction({ kind: 'url', target: 'https://example.com/a' })).args, ['-u', 'https://example.com/a']);
    for (const target of ['file:///etc/passwd', 'javascript:alert(1)', 'x-apple.systempreferences:com.apple.preference.security', 'ssh://host']) {
      assert.match((await planAction({ kind: 'url', target })).problem, /only http and https/, target);
    }
    assert.match((await planAction({ kind: 'url', target: 'https://user:pw@example.com' })).problem, /login/);
    assert.match((await planAction({ kind: 'url', target: 'not a url' })).problem, /not a web address/);
  });

  test('apps open by name, except the ones that can run commands', async () => {
    assert.deepEqual((await planAction({ kind: 'app', target: 'Safari.app' })).args, ['-a', 'Safari']);
    for (const target of ['Terminal', 'iTerm', 'Script Editor', 'automator']) {
      assert.match((await planAction({ kind: 'app', target })).problem, /can run commands/, target);
    }
    assert.match((await planAction({ kind: 'app', target: '../../bin/sh' })).problem, /not an app name/);
  });

  describe('files', () => {
    let root;
    let outside;
    before(async () => {
      root = await mkdtemp(join(tmpdir(), 'scope-actions-'));
      outside = await mkdtemp(join(tmpdir(), 'scope-outside-'));
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src', 'app.js'), 'export default 1;\n');
      await writeFile(join(root, 'run.command'), 'echo hi\n');
      await writeFile(join(outside, 'secret.txt'), 'no\n');
      await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    });

    test('a project file opens in a text editor, never executed', async () => {
      const plan = await planAction({ kind: 'file', target: 'src/app.js' }, { localPath: root });
      assert.equal(plan.args[0], '-t');
      assert.ok(plan.args[1].endsWith(join('src', 'app.js')));
      const command = await planAction({ kind: 'file', target: 'run.command' }, { localPath: root });
      assert.equal(command.args[0], '-t', 'a .command file is shown as text, not run');
    });

    test('nothing outside the project folder opens, including through a symlink', async () => {
      for (const target of ['../secret.txt', `../${outside.split('/').pop()}/secret.txt`, 'link.txt', '/etc/hosts', 'src', 'missing.js']) {
        const plan = await planAction({ kind: 'file', target }, { localPath: root });
        assert.ok(plan.problem, `${target} should be refused`);
        assert.equal(plan.args, undefined);
      }
    });

    test('without a working copy there is nowhere to open a file from', async () => {
      assert.match((await planAction({ kind: 'file', target: 'src/app.js' }, {})).problem, /no working copy/);
    });
  });
});

describe('recordActions and executeAction', () => {
  test('off macOS every action is refused rather than attempted', async () => {
    const [action] = await recordActions({ ownerId: 'u', conversationId: 'c', found: [{ kind: 'search', target: 'x' }], platform: 'linux' });
    assert.equal(action.state, 'refused');
    assert.match(action.problem, /macOS/);
  });

  test('execution calls open with exactly the planned arguments and no shell', async () => {
    const calls = [];
    const run = (file, args, options, done) => {
      calls.push({ file, args, shell: options.shell });
      done(null, '', '');
    };
    const [action] = await recordActions({ ownerId: 'u', conversationId: 'c', found: [{ kind: 'url', target: 'https://example.com' }], platform: 'darwin' });
    assert.deepEqual(await executeAction(action, { run }), { ok: true });
    assert.deepEqual(calls, [{ file: 'open', args: ['-u', 'https://example.com/'], shell: undefined }]);
  });

  test('a failed open reports why', async () => {
    const run = (file, args, options, done) => done(new Error('exit 1'), '', 'Unable to find application named Nope');
    const [action] = await recordActions({ ownerId: 'u', conversationId: 'c', found: [{ kind: 'app', target: 'Nope' }], platform: 'darwin' });
    assert.deepEqual(await executeAction(action, { run }), { ok: false, error: 'Unable to find application named Nope' });
  });
});

describe('autoOpens', () => {
  const action = (kind, target, state = 'proposed') => ({ kind, target, state });

  test('in display mode searches, apps and files open by themselves', () => {
    for (const kind of ['search', 'app', 'file']) assert.equal(autoOpens(action(kind, 'x')), true, kind);
  });
  test('a web address opens by itself only if the search cited it, compared as normalised URLs', () => {
    assert.equal(autoOpens(action('url', 'https://example.com'), { citedUrls: ['https://example.com/'] }), true);
    assert.equal(autoOpens(action('url', 'https://example.com/other'), { citedUrls: ['https://example.com/'] }), false);
    assert.equal(autoOpens(action('url', 'https://example.com/')), false, 'nothing cited, nothing auto-opens');
  });
  test('refused or already-decided actions never open', () => {
    for (const state of ['refused', 'rejected', 'opened', 'failed']) assert.equal(autoOpens(action('search', 'x', state)), false, state);
  });
});
