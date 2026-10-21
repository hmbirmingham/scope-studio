import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { checkoutRoot, resolveInside } from '../../src/plugins/code/paths.js';
import code from '../../src/plugins/code/index.js';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'scope-code-unit-')));
const root = join(scratch, 'project');
mkdirSync(join(root, 'src'), { recursive: true });
writeFileSync(join(root, 'src', 'a.js'), 'a');
writeFileSync(join(scratch, 'outside.txt'), 'outside');
after(() => rmSync(scratch, { recursive: true, force: true }));

describe('resolveInside', () => {
  test('resolves relative paths inside the project', () => {
    assert.deepEqual(resolveInside(root, 'src/a.js'), { abs: join(root, 'src', 'a.js'), rel: 'src/a.js' });
    // A file that does not exist yet still resolves, for an edit that creates it.
    assert.equal(resolveInside(root, './src/b.js').rel, 'src/b.js');
  });

  test('refuses absolute paths, .. segments, the git directory and the root itself', () => {
    for (const path of ['/etc/passwd', 'C:\\Windows', '../outside.txt', 'src/../../outside.txt', 'src\\..\\..\\outside.txt', '.git/config', 'sub/.GIT/hooks/x', '.']) {
      assert.throws(() => resolveInside(root, path), { code: 'path_escapes' }, path);
    }
    for (const path of ['', null, 42, 'a\0b', 'x'.repeat(2000)]) {
      assert.throws(() => resolveInside(root, path), { code: 'invalid_path' });
    }
  });

  test('follows symlinks and refuses the ones that lead out', () => {
    symlinkSync(join(scratch, 'outside.txt'), join(root, 'out-link'));
    symlinkSync(scratch, join(root, 'out-dir'));
    symlinkSync('src/a.js', join(root, 'in-link'));
    assert.throws(() => resolveInside(root, 'out-link'), { code: 'path_escapes' });
    assert.throws(() => resolveInside(root, 'out-dir/new-file.txt'), { code: 'path_escapes' });
    assert.deepEqual(resolveInside(root, 'in-link').rel, 'src/a.js');
  });
});

describe('checkoutRoot', () => {
  test('prefers the sandbox copy and can insist on it', () => {
    assert.equal(checkoutRoot({ sandbox: { worktree: root }, localPath: scratch }), root);
    assert.equal(checkoutRoot({ localPath: root }), root);
    assert.throws(() => checkoutRoot({ localPath: root }, { sandboxOnly: true }), { code: 'sandbox_required' });
    assert.throws(() => checkoutRoot({}), { code: 'no_checkout' });
    assert.throws(() => checkoutRoot({ localPath: join(scratch, 'missing') }), { code: 'no_checkout' });
  });
});

describe('code plug-in declaration', () => {
  test('every capability declares an input schema with its required fields', () => {
    for (const capability of code.capabilities) {
      assert.equal(capability.input.type, 'object', capability.name);
      for (const field of capability.input.required) assert.ok(capability.input.properties[field], `${capability.name}.${field}`);
    }
  });

  test('inputs are validated before anything runs', async () => {
    const ctx = { sandbox: { worktree: root, scratch }, localPath: root };
    const byName = Object.fromEntries(code.capabilities.map((c) => [c.name, c]));
    await assert.rejects(byName['code.search'].run({ query: '' }, ctx), { code: 'invalid_input' });
    await assert.rejects(byName['code.search'].run({ query: 'a', maxResults: 10_000 }, ctx), { code: 'invalid_input' });
    await assert.rejects(byName['code.read'].run({ path: 'src/a.js', startLine: 0 }, ctx), { code: 'invalid_input' });
    await assert.rejects(byName['code.edit'].run({ path: 'src/a.js', search: 'a' }, ctx), { code: 'invalid_input' });
    await assert.rejects(byName['code.run_generated'].run({ language: 'node', code: 'x', timeoutMs: 10 }, ctx), { code: 'invalid_input' });
  });
});
