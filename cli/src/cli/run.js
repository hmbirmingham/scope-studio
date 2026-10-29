import { generate } from '../runners/local.js';
import { failureConstraint, runGates } from '../eval/check.js';
import { writeRun } from '../core/ledger.js';
import { loadTask } from '../core/task.js';
import { ensureAgentDirs } from '../core/vault.js';

// Phase 0 derives the system prompt from the gates themselves. From phase 2 a
// rubric file supersedes this: the same file holds the prose the generator is
// given and the numbered lines the judge checks, so the two cannot drift. The
// shape is the same either way — the constraints the work is judged by are the
// constraints the work is given.
function systemPrompt(task) {
  return [
    'You are answering a task that will be checked automatically before it is accepted.',
    'The checks are:',
    ...task.gates.map((g) => `- ${g.id}: ${g.check}${g.arg !== undefined ? ` ${g.arg}` : ''}`),
    '',
    'Write only the answer. No preamble, no restatement of the task, no notes about these checks.',
  ].join('\n');
}

export default async function runCommand(config, taskRef, { verbose = false } = {}) {
  const task = await loadTask(config, taskRef);
  await ensureAgentDirs(config);

  const startedAt = new Date();
  const attempts = [];
  let constraint = null;

  for (let n = 1; n <= task.attempts; n += 1) {
    const prompt = constraint
      ? `${task.prompt}\n\nYour previous answer failed these checks. Fix exactly these and change nothing else:\n${constraint}`
      : task.prompt;

    process.stderr.write(`  attempt ${n}/${task.attempts} on ${config.ollama.model}… `);
    const result = await generate(config, { system: systemPrompt(task), prompt });
    const { passed, results } = runGates(task.gates, result.output);
    process.stderr.write(`${passed ? 'passed' : 'failed'} (${result.ms} ms)\n`);

    attempts.push({ n, ...result, passed, results });
    if (verbose) {
      for (const r of results) console.error(`      ${r.ok ? '✅' : '❌'} ${r.id}: ${r.detail}`);
    }
    if (passed) break;
    // Rubric-aware retry: the next attempt is told exactly which line it broke.
    constraint = failureConstraint(results);
  }

  const passed = attempts.at(-1).passed;
  const { path, commit } = await writeRun(config, { task, startedAt, attempts, passed });

  console.log('');
  console.log(passed ? attempts.at(-1).output : 'Task failed its checks. Nothing is being passed off as done.');
  console.log('');
  console.error(`trace: ${path}`);
  if (!commit.committed) console.error(`not committed: ${commit.reason}`);
  return passed ? 0 : 1;
}
