import { commitVault, writeNote } from './vault.js';

// Every run leaves a note in the vault. The trace is the product of a run as
// much as the answer is: it is what makes a slow agent trustworthy, and it is
// what the eval replay reads later.

function stamp(date) {
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function gateLine(r) {
  return `| ${r.ok ? '✅' : '❌'} | \`${r.id}\` | \`${r.check}\` | ${r.detail} |`;
}

function attemptSection(attempt) {
  return [
    `### Attempt ${attempt.n} — ${attempt.passed ? 'passed' : 'failed'}`,
    '',
    `Model \`${attempt.model}\` · ${attempt.ms} ms · ${attempt.tokensIn ?? '?'} in / ${attempt.tokensOut ?? '?'} out`,
    '',
    '| | gate | check | detail |',
    '| --- | --- | --- | --- |',
    ...attempt.results.map(gateLine),
    '',
    '<details><summary>Output</summary>',
    '',
    attempt.output || '_(empty)_',
    '',
    '</details>',
  ].join('\n');
}

/**
 * Write a human-readable run trace into the vault and commit it.
 * @returns {{path: string, commit: {committed: boolean, reason?: string}}}
 */
export async function writeRun(config, run) {
  const name = `${stamp(run.startedAt)}-${run.task.id}.md`;
  const body = [
    `# ${run.task.id}`,
    '',
    `> ${run.task.prompt.split('\n').join('\n> ')}`,
    '',
    `**Verdict:** ${run.passed ? 'passed' : 'failed'} after ${run.attempts.length} attempt${run.attempts.length > 1 ? 's' : ''}.`,
    ...(run.passed ? [] : ['', 'Escalated to you with the trace below rather than returning a partial answer.']),
    '',
    ...run.attempts.map(attemptSection),
  ].join('\n');

  const path = await writeNote(config, `runs/${name}`, {
    fields: {
      type: 'scope-run',
      task: run.task.id,
      use_case: run.task.useCase ?? undefined,
      started: run.startedAt.toISOString(),
      passed: run.passed,
      attempts: run.attempts.length,
      source: run.task.source,
    },
    body,
  });

  const commit = await commitVault(config, `scope: run ${run.task.id} (${run.passed ? 'passed' : 'failed'})`);
  return { path, commit };
}
