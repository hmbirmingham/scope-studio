import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureConstraint, runGates } from '../src/eval/check.js';

test('word-count gates measure words, not characters', () => {
  const { results } = runGates(
    [
      { id: 'min', check: 'min_words', arg: 3 },
      { id: 'max', check: 'max_words', arg: 4 },
    ],
    'one two three'
  );
  assert.deepEqual(results.map((r) => r.ok), [true, true]);
});

test('every_paragraph_matches ignores headings but catches an uncited paragraph', () => {
  const brief = '# Findings\n\nRAG recall is measured with nDCG [1].\n\nSome vibe with no source.\n';
  const { passed, results } = runGates(
    [{ id: 'cited', check: 'every_paragraph_matches', arg: '\\[\\d+\\]' }],
    brief
  );
  assert.equal(passed, false);
  assert.match(results[0].detail, /paragraph 2 lack/);
});

test('no_placeholder catches the things an 8B model says when it is out of substance', () => {
  const { passed, results } = runGates([{ id: 'ph', check: 'no_placeholder' }], 'TODO: finish this');
  assert.equal(passed, false);
  assert.match(results[0].detail, /TODO/);
});

test('an unknown check fails closed rather than passing silently', () => {
  const { passed, results } = runGates([{ id: 'x', check: 'does_not_exist' }], 'anything');
  assert.equal(passed, false);
  assert.match(results[0].detail, /unknown check/);
});

test('failureConstraint reports only what failed', () => {
  const { results } = runGates(
    [
      { id: 'ok', check: 'non_empty' },
      { id: 'bad', check: 'min_words', arg: 50 },
    ],
    'short'
  );
  const constraint = failureConstraint(results);
  assert.match(constraint, /1 words, minimum 50/);
  assert.equal(constraint.split('\n').length, 1);
});
