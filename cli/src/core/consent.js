// Asking, and what happens when there is nobody to ask.
//
// The rule that makes the rest of the gate trustworthy: **an ask with no human
// present is a refusal, never an approval.** If stdin is not a terminal — a
// cron job, a pipe, a background run, a CI step — the answer is no. The
// tempting alternative is to let an unattended run proceed on the grounds that
// the user set it up and must have meant it, which is precisely how an
// approval gate becomes decoration.
//
// What is shown is the ACTUAL diff or the ACTUAL argv, never the model's
// account of them. A model describing its own edit is the same category of
// evidence as a model quoting its own prose: it is the thing being checked, so
// it does not get to narrate. An approval granted against a summary is an
// approval of the summary.

import { createInterface } from 'node:readline/promises';

export class Refused extends Error {}

const BAR = '─'.repeat(72);

/** One approval prompt. Returns true only on an explicit yes from a terminal. */
export async function ask({ title, reason, body, irreversible = false, flags = [] }) {
  if (!process.stdin.isTTY) {
    throw new Refused(
      `${title}: needs approval and stdin is not a terminal. ` +
        `Refused rather than assumed — run this attended.`
    );
  }

  process.stderr.write(`\n${BAR}\n`);
  process.stderr.write(`${irreversible ? '⚠️  IRREVERSIBLE — ' : ''}${title}\n`);
  process.stderr.write(`${reason}\n`);
  for (const flag of flags) {
    process.stderr.write(
      flag === 'test_oracle'
        ? '⚠️  this edits the test oracle — "the tests pass" means nothing if the tests moved\n'
        : flag === 'outside_workspace'
          ? '⚠️  this writes outside the bound workspace — there is no git undo for it\n'
          : flag === 'escape_flag'
            ? '⚠️  a read-only command carrying a flag that can execute code\n'
            : `⚠️  ${flag}\n`
    );
  }
  if (body) process.stderr.write(`${BAR}\n${body}\n`);
  process.stderr.write(`${BAR}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // No default. An empty line is not consent, and `y` is the only yes —
    // nothing here accepts "sure" or a bare return, because a reflex keystroke
    // is what approval fatigue looks like at the keyboard.
    const answer = await rl.question('approve? [y/N] ');
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

/**
 * How many proposals one run may put in front of you.
 *
 * Not a per-run approval — a per-run budget. Forty prompts is how an approval
 * gate stops being read, and an approval you did not read is worse than none
 * because it manufactures confidence. Past the cap the run stops and explains
 * itself rather than grinding you down.
 */
export const MAX_PROPOSALS_PER_RUN = 12;

export function proposalBudget(max = MAX_PROPOSALS_PER_RUN) {
  let used = 0;
  return {
    spend() {
      used += 1;
      if (used > max) {
        throw new Refused(
          `this run wanted more than ${max} approvals. Stopping: past a dozen prompts ` +
            `nobody is reading them. Narrow the task, or raise the cap on purpose.`
        );
      }
      return { used, max };
    },
    get used() {
      return used;
    },
  };
}
