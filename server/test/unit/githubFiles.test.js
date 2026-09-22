import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CHUNK_CHARS,
  chunkExternalId,
  chunkText,
  isEligible,
  prioritize,
} from '../../src/plugins/github/files.js';

const blob = (path, size = 100) => ({ type: 'blob', path, size, sha: 'x' });

describe('isEligible', () => {
  test('accepts source, docs, config, notebooks, CAD, and known basenames', () => {
    for (const path of [
      'src/quantify.py', 'README.md', 'config.yaml', 'notebooks/eval.ipynb', 'board/main.kicad_sch',
      'Makefile', 'thesis/main.tex', 'src/App.jsx', '.github/workflows/ci.yml',
    ]) {
      assert.ok(isEligible(blob(path)), path);
    }
  });

  test('rejects lockfiles, vendored directories, minified assets, binaries, and trees', () => {
    for (const path of [
      'package-lock.json', 'node_modules/x/index.js', 'dist/app.min.js', 'bundle.js.map',
      'images/logo.png', 'bin/tool', 'coverage/lcov.info', 'go.sum', 'src/__snapshots__/a.snap',
    ]) {
      assert.equal(isEligible(blob(path)), false, path);
    }
    assert.equal(isEligible({ type: 'tree', path: 'src', size: 0 }), false);
  });

  test('enforces the size cap and skips empty files', () => {
    assert.equal(isEligible(blob('big.py', 200 * 1024)), false);
    assert.equal(isEligible(blob('empty.py', 0)), false);
    assert.ok(isEligible(blob('small.py', 5 * 1024), { maxFileBytes: 10 * 1024 }));
    assert.equal(isEligible(blob('small.py', 15 * 1024), { maxFileBytes: 10 * 1024 }), false);
  });
});

describe('prioritize', () => {
  test('shallow paths first, then alphabetical', () => {
    const order = prioritize([
      blob('src/deep/nested/test_fixture.py'), blob('src/b.py'), blob('README.md'), blob('src/a.py'),
    ]).map((entry) => entry.path);
    assert.deepEqual(order, ['README.md', 'src/a.py', 'src/b.py', 'src/deep/nested/test_fixture.py']);
  });
});

describe('chunkText', () => {
  test('short text is a single chunk', () => {
    assert.deepEqual(chunkText('a\nb\nc'), ['a\nb\nc']);
  });

  test('splits on line boundaries and carries an overlap forward', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${String(i).padStart(3, '0')} ${'x'.repeat(40)}`);
    const chunks = chunkText(lines.join('\n'));
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= CHUNK_CHARS + 400, 'chunk stays near the size limit');
      assert.ok(!chunk.startsWith('x'), 'never starts mid-line');
    }
    const firstOfSecond = chunks[1].split('\n')[0];
    assert.ok(chunks[0].includes(firstOfSecond), 'second chunk begins with lines the first already had');
  });

  test('a definition that would straddle a boundary is findable in one chunk', () => {
    const filler = Array.from({ length: 70 }, (_, i) => `x = ${i}  ${'#'.repeat(35)}`).join('\n');
    const text = `${filler}\ndef quantify_colonies(mask):\n    return mask.sum()\n`;
    const hit = chunkText(text).filter((chunk) => chunk.includes('def quantify_colonies'));
    assert.ok(hit.length >= 1);
    assert.ok(hit.some((chunk) => chunk.includes('return mask.sum()')));
  });

  test('a pathological single line is hard-capped, and blank input yields nothing', () => {
    const chunks = chunkText('y'.repeat(50_000));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, CHUNK_CHARS * 2);
    assert.deepEqual(chunkText('\n\n  \n'), []);
  });
});

describe('chunkExternalId', () => {
  test('index precedes the path so paths may contain any character', () => {
    assert.equal(chunkExternalId(42, 3, 'a|b/c#d.py'), '42|3|a|b/c#d.py');
  });
});
