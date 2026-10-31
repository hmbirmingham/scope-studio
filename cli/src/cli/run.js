import { generate } from '../runners/local.js';
import { failureConstraint, runGates } from '../eval/check.js';
import { writeRun } from '../core/ledger.js';
import { loadTask } from '../core/task.js';
import { agentPath, ensureAgentDirs } from '../core/vault.js';
import { readFile } from 'node:fs/promises';

// A task with a use_case is given its rubric's prose verbatim: the constraints
// the work is judged by are the constraints the work is given. Without one, the
// gates are described instead, which is weaker but still honest.
function systemPrompt(task) {
  if (task.instructions) return task.instructions;
  return [
    'You are answering a task that will be checked automatically before it is accepted.',
    'The checks are:',
    ...task.gates.map((g) => `- ${g.id}: ${g.check}${g.arg !== undefined ? ` ${g.arg}` : ''}`),
    '',
    'Write only the answer. No preamble, no restatement of the task, no notes about these checks.',
  ].join('\n');
}

/** The material a task works from, read straight out of the vault. */
async function readSources(config, task) {
  const parts = [];
  for (const relPath of task.sources) {
    const text = await readFile(agentPath(config, relPath), 'utf8');
    parts.push(`<source path="${relPath}">\n${text.trim()}\n</source>`);
  }
  return parts.join('\n\n');
}

export default async function runCommand(config, taskRef, { verbose = false } = {}) {
  const task = await loadTask(config, taskRef);
  await ensureAgentDirs(config);
  const sources = task.sources.length ? await readSources(config, task) : '';
  if (task.sources.length) {
    console.error(`  sources: ${task.sources.join(', ')}`);
  }
  if (task.rubricSource) {
    console.error(`  rubric:  ${task.rubricSource} (${task.gates.length} gates, ${task.rubricLines.length} judged lines)`);
  }

  const startedAt = new Date();
  const attempts = [];
  let constraint = null;

  for (let n = 1; n <= task.attempts; n += 1) {
    const asked = sources ? `${task.prompt}\n\nSource material:\n\n${sources}` : task.prompt;
    const prompt = constraint
      ? `${asked}\n\nYour previous answer failed these checks. Fix exactly these and change nothing else:\n${constraint}`
      : asked;

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
