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
    ...(attempt.grounding
      ? [
          `Analysis: ${attempt.claimCount} claims · ${attempt.grounding.grounded.length} grounded · ${attempt.grounding.ungrounded.length} ungrounded`,
          '',
          ...(attempt.grounding.ungrounded.length
            ? [
                'Quotes not found in the source material:',
                '',
                ...attempt.grounding.ungrounded.map((u) => `- under *${u.heading ?? 'untitled'}*: "${u.quote}"`),
                '',
              ]
            : []),
        ]
      : []),
    '<details><summary>Output</summary>',
    '',
    attempt.output || '_(empty)_',
    '',
    '</details>',
  ].join('\n');
}

/**
 * What the run was given, and what it was not.
 *
 * A gate failure caused by selection and one caused by the model look identical
 * in the output: both read as a model that could not cite its sources. The only
 * way to tell them apart later is to record what was left out at the time, so
 * this goes in the trace whether or not the run passed.
 */
function contextSection(run) {
  if (!run.route && !run.selection) return [];
  const lines = ['## Context', ''];
  if (run.route) {
    lines.push(`Tier: \`${run.route.tier}\` — ${run.route.reason}.`, '');
  }
  if (run.selection) {
    const { selected, total, elided, tokens, dense, terms } = run.selection;
    lines.push(
      `Source material did not fit the window, so it was selected rather than refused: ` +
        `**${selected} of ${total} chunks**, ~${tokens} tokens, ranked ` +
        `${dense ? 'densely and lexically' : 'lexically only (embeddings unavailable)'} on ` +
        `[${terms.join(', ')}].`,
      '',
      `${elided} chunk${elided === 1 ? '' : 's'} were not shown to the model. A missing claim or an ` +
        `uncitable one may be theirs rather than the model's.`,
      ''
    );
  } else {
    lines.push('Source material fit the window whole; nothing was selected away.', '');
  }
  return lines;
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
    ...(run.best && run.attempts.length > 1
      ? [
          '',
          `Best attempt: **${run.best.n}**, ${run.best.results.filter((r) => r.ok).length} of ` +
            `${run.best.results.length} gates. The verdict is this attempt's, not the last one's — ` +
            `a retry loop that can regress must not discard work it already had.`,
        ]
      : []),
    ...(run.passed ? [] : ['', 'Escalated to you with the trace below rather than returning a partial answer.']),
    '',
    ...contextSection(run),
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
      tier: run.route?.tier ?? undefined,
      chunks_selected: run.selection ? run.selection.selected : undefined,
      chunks_total: run.selection ? run.selection.total : undefined,
      source: run.task.source,
    },
    body,
  });

  const commit = await commitVault(config, `scope: run ${run.task.id} (${run.passed ? 'passed' : 'failed'})`);
  return { path, commit };
}
