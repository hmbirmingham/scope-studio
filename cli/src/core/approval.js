// What the agent may do without asking, and what it may never do without asking.
//
// This is the gate that makes a screen runner possible later, so it is sized
// for the screen runner and not for the case that happens to be convenient.
// Approval granularity tracks REVERSIBILITY: a wrong file write on a scratch
// branch is one git command away from undone, and a wrong click that submits a
// form is not undoable at all. The mechanism is shared by both, so it is built
// for the second.
//
// Three outcomes, and only three:
//
//   auto    provably cannot change state — observation only
//   ask     everything that can change anything
//   refuse  anything this file does not recognise
//
// `refuse` for the unrecognised is the same fail-closed rule the gate registry
// uses for an unknown check. A classifier that passed unknown actions through
// to `ask` would look safe and would be a hole: the point of naming a kind is
// that the policy has been thought about, and an unnamed kind has not.
//
// There is deliberately no flag that turns `ask` into `auto`. Not a
// --yes, not an --unattended, not a config key. An unattended mode is exactly
// the thing that would make this gate decorative the first time it is
// inconvenient.

import { isAbsolute, relative, resolve } from 'node:path';

export const AUTO = 'auto';
export const ASK = 'ask';
export const REFUSE = 'refuse';

/**
 * Commands that cannot change state, by exact subcommand.
 *
 * The cheapest cheat an auto-approved read class invites is ARGUMENT
 * INJECTION: `git` is only read-only until you pass it the right flag.
 * `git log --ext-diff` runs an external diff program, `-c core.pager=…` runs a
 * pager of your choosing, `--exec-path` relocates the helper binaries, and
 * `--output` writes a file. Every one of those turns a "read-only" command into
 * arbitrary execution, so the allowlist is per-subcommand and the arguments are
 * checked against a denylist of the flags that escape.
 */
const READ_ONLY = {
  git: new Set(['status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'branch']),
};

// Flags that give a read-only command a way out. Matched as a prefix so
// `--output=x` and `--output x` are both caught.
const ESCAPE_FLAGS = [
  '-c',
  '--config-env',
  '--exec-path',
  '--output',
  '--ext-diff',
  '--upload-pack',
  '--receive-pack',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--no-pager', // harmless itself, but pager handling is where config lands
  '--pager',
];

function escapes(args) {
  return args.some((arg) => ESCAPE_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

/** Is this path inside the workspace the task is bound to? */
export function withinWorkspace(workspace, path) {
  if (!workspace) return false;
  const root = resolve(workspace);
  const rel = relative(root, resolve(root, path));
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Classify one proposed action.
 *
 * @param {object} action
 * @param {string} action.kind  read_command | read_file | write_file | shell | screen | network
 * @param {string} [action.command] the executable, for commands
 * @param {string[]} [action.args]
 * @param {string} [action.path] the target, for file actions
 * @param {object} ctx
 * @param {string} ctx.workspace absolute path the task is bound to
 * @param {string[]} [ctx.protectedPaths] workspace-relative prefixes that hold
 *   the test oracle. A write here still only ever asks — approval does not
 *   refuse it — but it is flagged, because "the tests now pass" means nothing
 *   if the tests moved.
 * @returns {{decision: string, reason: string, irreversible?: boolean, flags?: string[]}}
 */
export function classify(action, ctx = {}) {
  const { workspace, protectedPaths = [] } = ctx;

  switch (action?.kind) {
    case 'read_command': {
      const allowed = READ_ONLY[action.command];
      if (!allowed) return { decision: ASK, reason: `${action.command} is not on the read-only allowlist` };
      const [sub, ...rest] = action.args ?? [];
      if (!allowed.has(sub)) return { decision: ASK, reason: `${action.command} ${sub ?? ''} is not a read-only subcommand` };
      if (escapes(rest)) {
        // Not merely `ask`: a read-only command carrying an escape flag is an
        // attempt to execute through a hole, and should be seen as one.
        return { decision: ASK, reason: `${action.command} ${sub} carries a flag that can execute code`, flags: ['escape_flag'] };
      }
      if (!workspace) return { decision: ASK, reason: 'no workspace is bound, so nothing is provably contained' };
      return { decision: AUTO, reason: `${action.command} ${sub} cannot change state` };
    }

    case 'read_file': {
      if (!withinWorkspace(workspace, action.path)) {
        return { decision: ASK, reason: `${action.path} is outside the bound workspace` };
      }
      return { decision: AUTO, reason: 'reading inside the workspace' };
    }

    case 'write_file': {
      const inside = withinWorkspace(workspace, action.path);
      const rel = inside ? relative(resolve(workspace), resolve(workspace, action.path)) : action.path;
      const guarded = inside && protectedPaths.some((p) => rel === p || rel.startsWith(`${p}/`));
      return {
        decision: ASK,
        reason: inside ? `writes ${rel}` : `writes OUTSIDE the workspace: ${action.path}`,
        irreversible: !inside,
        flags: [...(guarded ? ['test_oracle'] : []), ...(inside ? [] : ['outside_workspace'])],
      };
    }

    // Executing anything is a state change: a Makefile runs arbitrary code, and
    // a project-declared script is still a script.
    case 'shell':
      return { decision: ASK, reason: `runs ${action.command} ${(action.args ?? []).join(' ')}`.trim() };

    // No undo exists for either of these, which is the whole reason this file
    // is shaped the way it is.
    case 'screen':
      return { decision: ASK, reason: action.summary ?? 'acts on the screen', irreversible: true };
    case 'network':
      return { decision: ASK, reason: action.summary ?? 'leaves the machine', irreversible: true };

    default:
      return { decision: REFUSE, reason: `unknown action kind "${action?.kind}" — refused rather than guessed` };
  }
}
