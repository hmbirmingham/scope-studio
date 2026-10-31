import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRubric, parseRubricLines, loadRubric } from '../src/eval/rubric.js';
import { parseTask } from '../src/core/task.js';

const rubricText = `---
use_case: concept-note
version: 1
important: true
---

## Instructions

Write one concept per entry. Keep the numbers.

## Gates

- headed: must_match ^### .+
- not-padded: max_words 500
- no-filler: no_placeholder

## Rubric

1. Every concept appears in the source material.
2. No numeric detail is dropped.
`;

test('a rubric parses its three consumers out of one file', () => {
  const rubric = parseRubric(rubricText, 'r.md');
  assert.equal(rubric.useCase, 'concept-note');
  assert.equal(rubric.important, true);
  assert.match(rubric.instructions, /^Write one concept per entry/);
  assert.deepEqual(rubric.lines, [
    'Every concept appears in the source material.',
    'No numeric detail is dropped.',
  ]);
  assert.match(rubric.gatesText, /headed: must_match/);
});

test('a rubric without instructions is refused', () => {
  assert.throws(() => parseRubric('---\nuse_case: x\n---\n## Rubric\n1. a\n', 'r.md'), /needs an "## Instructions"/);
});

test('parseRubricLines ignores prose and keeps only numbered lines', () => {
  assert.deepEqual(parseRubricLines('intro text\n1. first\n- bullet\n2. second\n'), ['first', 'second']);
});

test('a task inherits its rubric gates and instructions', () => {
  const rubric = parseRubric(rubricText, 'r.md');
  const task = parseTask('---\nid: t\nuse_case: concept-note\n---\n## Task\nextract\n', 't.md', rubric);
  assert.deepEqual(task.gates.map((g) => g.id), ['headed', 'not-padded', 'no-filler']);
  assert.match(task.instructions, /Keep the numbers/);
  assert.equal(task.important, true, 'importance comes from the rubric too');
  assert.equal(task.rubricLines.length, 2);
});

test("a task's own gate overrides the rubric's gate of the same id", () => {
  const rubric = parseRubric(rubricText, 'r.md');
  const task = parseTask(
    '---\nid: t\nuse_case: concept-note\n---\n## Task\nextract\n\n## Gates\n- not-padded: max_words 120\n',
    't.md',
    rubric
  );
  const padded = task.gates.filter((g) => g.id === 'not-padded');
  assert.equal(padded.length, 1, 'not duplicated');
  assert.equal(padded[0].arg, 120, "the task's tighter limit wins");
  assert.deepEqual(task.gates.map((g) => g.id), ['headed', 'no-filler', 'not-padded']);
});

test('a task with a rubric needs no gates of its own', () => {
  const rubric = parseRubric(rubricText, 'r.md');
  assert.doesNotThrow(() => parseTask('---\nid: t\n---\n## Task\nx\n', 't.md', rubric));
  // But with no rubric and no gates it is still refused.
  assert.throws(() => parseTask('---\nid: t\n---\n## Task\nx\n', 't.md'), /no gates/);
});

test('Sources are read as a list of vault-relative paths', () => {
  const task = parseTask(
    '---\nid: t\n---\n## Task\nx\n\n## Sources\n- meetings/a.md\n- meetings/b.md\n\n## Gates\n- g: non_empty\n',
    't.md'
  );
  assert.deepEqual(task.sources, ['meetings/a.md', 'meetings/b.md']);
});

test('the shipped concept-note rubric loads and its gates are all known checks', async () => {
  const rubric = await loadRubric('concept-note');
  const task = parseTask('---\nid: t\nuse_case: concept-note\n---\n## Task\nx\n', 't.md', rubric);
  assert.ok(task.gates.length >= 5);
  assert.ok(rubric.lines.length >= 5);
});
