// Running commands, under the approval gate.
//
// execFile, never a shell. The first design of this was `/bin/sh -c <string>`
// and that was correctly killed as an RCE surface: once a shell parses the
// string, every quoting mistake and every `;` in a model's output is an
// arbitrary command. argv is passed as an array and nothing interpolates.
//
// cwd is pinned to the bound workspace. A command is only as contained as the
// directory it starts in, and "the agent ran the tests" should not be able to
// mean "the agent ran something in my home directory".

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { AUTO, REFUSE, classify } from '../core/approval.js';
import { Refused, ask } from '../core/consent.js';

const run = promisify(execFile);

/**
 * Execute one command after clearing the approval gate.
 *
 * @param {object} spec
 * @param {string} spec.command the executable
 * @param {string[]} spec.args
 * @param {boolean} [spec.readOnly] the CALLER's claim that this only observes.
 *   It is a hint, not a grant: `classify` decides, and a command that is not on
 *   the read-only allowlist still asks however it was labelled.
 * @param {object} ctx
 * @param {string} ctx.workspace
 * @param {{spend: function}} [ctx.budget]
 */
export async function runCommand(spec, ctx) {
  const action = {
    kind: spec.readOnly ? 'read_command' : 'shell',
    command: spec.command,
    args: spec.args ?? [],
  };
  const verdict = classify(action, ctx);

  if (verdict.decision === REFUSE) {
    throw new Refused(`refused: ${verdict.reason}`);
  }
  if (verdict.decision !== AUTO) {
    ctx.budget?.spend();
    const approved = await ask({
      title: `run ${spec.command} ${(spec.args ?? []).join(' ')}`.trim(),
      reason: verdict.reason,
      irreversible: verdict.irreversible,
      flags: verdict.flags,
    });
    if (!approved) throw new Refused(`you declined: ${spec.command} ${(spec.args ?? []).join(' ')}`.trim());
  }

  const started = Date.now();
  try {
    const { stdout, stderr } = await run(spec.command, spec.args ?? [], {
      cwd: resolve(ctx.workspace),
      // A test suite's output is the evidence a gate reads, so the cap is
      // generous — but it is a cap, because an unbounded pipe is a way to
      // exhaust this process rather than to report a result.
      maxBuffer: 8 * 1024 * 1024,
      timeout: spec.timeoutMs ?? 300_000,
      // No shell, and no inherited environment surprises beyond what the
      // caller passes.
      shell: false,
    });
    return { ok: true, code: 0, stdout, stderr, ms: Date.now() - started, approved: verdict.decision };
  } catch (err) {
    // A non-zero exit is a RESULT, not an error: "the tests failed" is exactly
    // what a gate needs to read. Only a failure to run at all is thrown.
    if (typeof err.code === 'number') {
      return {
        ok: false,
        code: err.code,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        ms: Date.now() - started,
        approved: verdict.decision,
      };
    }
    throw new Error(`could not run ${spec.command}: ${err.message}`);
  }
}
