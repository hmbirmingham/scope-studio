import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { parseEdits, resetProposals, resolveProject, verifyAgainstSources } from '../../src/editing/proposals.js';

const block = (path, search, replace) =>
  `<edit path="${path}">\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n</edit>`;

describe('parseEdits', () => {
  beforeEach(() => resetProposals());

  test('pulls edit blocks out of an answer and leaves the prose alone', () => {
    const answer = `Here is the fix [1].\n\n${block('src/quantify.py', 'return count', 'return count, areas')}\n\nThat keeps the areas.`;
    assert.deepEqual(parseEdits(answer), [
      { path: 'src/quantify.py', search: 'return count', replace: 'return count, areas' },
    ]);
  });

  test('reads several edits, including multi-line ones', () => {
    const answer = [
      block('a.py', 'x = 1\ny = 2', 'x = 10\ny = 20'),
      block('b/c.js', 'const a = 1;', 'const a = 2;'),
    ].join('\n\n');
    const edits = parseEdits(answer);
    assert.deepEqual(edits.map((edit) => edit.path), ['a.py', 'b/c.js']);
    assert.equal(edits[0].search, 'x = 1\ny = 2');
  });

  test('a malformed block is left as prose rather than guessed at', () => {
    assert.deepEqual(parseEdits('<edit path="a.py">\njust some text\n</edit>'), []);
    assert.deepEqual(parseEdits('no edits here at all'), []);
    assert.deepEqual(parseEdits(block('a.py', '', '')), [], 'an empty change is not an edit');
  });
});

describe('resolveProject', () => {
  const source = (content, project) => ({ node: { content, project } });

  test('matches a path to the project whose chunk carries it', () => {
    const sources = [
      source('src/quantify.py (part 2/3)\n\ndef quantify_colonies():', 'hmb/plates'),
      source('README.md\n\nnotes', 'hmb/other'),
    ];
    assert.equal(resolveProject('src/quantify.py', sources), 'hmb/plates');
    assert.equal(resolveProject('README.md', sources), 'hmb/other');
  });

  test('a path nobody retrieved has no home', () => {
    assert.equal(resolveProject('src/never_seen.py', [source('README.md\n\nx', 'hmb/other')]), null);
    assert.equal(resolveProject('a.py', []), null);
  });
});

describe('verifyAgainstSources', () => {
  const sources = [{ node: { content: 'q.py\n\ndef quantify(image):\n    return count\n', project: 'hmb/plates' } }];

  test('accepts a search copied verbatim from the excerpt', () => {
    assert.deepEqual(verifyAgainstSources({ search: '    return count' }, sources), { ok: true, reason: null });
  });

  test('rejects an abbreviated search before the user can approve it', () => {
    for (const search of [
      'def quantify(image):\n    # ... (rest of the function)',
      'def quantify(image):\n    ...',
      'def quantify(image):\n    // rest of the code',
    ]) {
      const verdict = verifyAgainstSources({ search }, sources);
      assert.equal(verdict.ok, false, `should reject: ${search}`);
      assert.match(verdict.reason, /abbreviated/);
    }
  });

  test('rejects a search the model invented', () => {
    const verdict = verifyAgainstSources({ search: 'def something_else():' }, sources);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /not in the excerpt/);
  });
});
