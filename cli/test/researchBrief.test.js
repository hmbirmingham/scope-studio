import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRubric } from '../src/eval/rubric.js';
import { parseTask } from '../src/core/task.js';
import { runGates } from '../src/eval/check.js';

const sources = `
<search query="how is retrieval quality measured">
Recall@k and nDCG are the standard offline measures.
</search>
<source index="1" uri="https://example.com/eval">
Evaluating retrieval
</source>
`;

test('the research-brief rubric loads with its gates and judged lines', async () => {
  const rubric = await loadRubric('research-brief');
  assert.equal(rubric.important, true, 'a brief leaves the machine, so it gets the cloud gate');
  const task = parseTask('---\nid: t\nuse_case: research-brief\n---\n## Task\nq\n', 't.md', rubric);
  const ids = task.gates.map((g) => g.id);
  for (const required of ['grounded', 'cited', 'not-copied', 'states-limits']) {
    assert.ok(ids.includes(required), `missing gate ${required}`);
  }
  assert.ok(rubric.lines.length >= 5);
});

test('a task declares its own search queries', () => {
  const task = parseTask(
    '---\nid: t\n---\n## Task\nq\n\n## Search\n- how is retrieval quality measured\n- what is nDCG\n\n## Gates\n- g: non_empty\n',
    't.md'
  );
  assert.deepEqual(task.searchQueries, ['how is retrieval quality measured', 'what is nDCG']);
});

test('a brief without its limits section fails the gate', async () => {
  const rubric = await loadRubric('research-brief');
  const task = parseTask('---\nid: t\nuse_case: research-brief\n---\n## Task\nq\n', 't.md', rubric);
  const withoutLimits = `### Recall@k is the standard measure
Teams measure how many relevant documents appear in the top k.
> Recall@k and nDCG are the standard offline measures.
`;
  const { results } = runGates(task.gates, withoutLimits, { sources });
  const limits = results.find((r) => r.id === 'states-limits');
  assert.equal(limits.ok, false);
});

test('a well-formed brief passes every deterministic gate', async () => {
  const rubric = await loadRubric('research-brief');
  const task = parseTask('---\nid: t\nuse_case: research-brief\n---\n## Task\nq\n', 't.md', rubric);
  const brief = `### Offline retrieval quality has two standard measures
Teams report both, since one counts coverage and the other counts ordering, and a brief
that gives only one hides whichever property it ignored from the reader entirely.
> Recall@k and nDCG are the standard offline measures.

### Only one source supports this
The brief says so rather than presenting a single citation as a settled consensus across
the field, which is the failure mode a reader cannot detect from the prose alone.
> Recall@k and nDCG are the standard offline measures.

### What this does not settle
The sources do not say which threshold of k teams actually use in production, nor whether
the two measures ever disagree enough to change a decision.
> Recall@k and nDCG are the standard offline measures.
`;
  const { passed, results } = runGates(task.gates, brief, { sources });
  assert.equal(passed, true, JSON.stringify(results.filter((r) => !r.ok), null, 2));
});
