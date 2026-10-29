import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTask } from '../src/core/task.js';

const good = `---
id: rag-eval-brief
use_case: research-brief
important: true
attempts: 3
---
## Task
How do people evaluate RAG retrieval?

## Gates
- cited: every_paragraph_matches \\[\\d+\\]
- length: max_words 400
- no-filler: no_placeholder
`;

test('parseTask reads frontmatter, prompt and gates', () => {
  const task = parseTask(good, 'x.md');
  assert.equal(task.id, 'rag-eval-brief');
  assert.equal(task.important, true);
  assert.equal(task.attempts, 3);
  assert.match(task.prompt, /^How do people/);
  assert.deepEqual(task.gates, [
    { id: 'cited', check: 'every_paragraph_matches', arg: '\\[\\d+\\]' },
    { id: 'length', check: 'max_words', arg: 400 },
    { id: 'no-filler', check: 'no_placeholder', arg: undefined },
  ]);
});

test('a task with no gates is refused at load time', () => {
  const text = '---\nid: x\n---\n## Task\ndo a thing\n';
  assert.throws(() => parseTask(text, 'x.md'), /no gates/);
});

test('an unknown check is refused at load time, not at run time', () => {
  const text = '---\nid: x\n---\n## Task\ndo a thing\n\n## Gates\n- g: vibes_good\n';
  assert.throws(() => parseTask(text, 'x.md'), /unknown check vibes_good/);
});

test('"## Question" is accepted as the prompt section', () => {
  const text = '---\nid: x\n---\n## Question\nwhy?\n\n## Gates\n- g: non_empty\n';
  assert.equal(parseTask(text, 'x.md').prompt, 'why?');
});

test('a task with no prompt section is refused', () => {
  const text = '---\nid: x\n---\n## Gates\n- g: non_empty\n';
  assert.throws(() => parseTask(text, 'x.md'), /needs a "## Task"/);
});
