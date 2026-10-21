import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrate } from '../../db/migrate.js';
import { getPool } from '../../db/pool.js';
import { BASELINE_WINDOW_TOKENS } from '../endurance/arms.js';
import { LIVE_MAX_USD, SpendCap } from '../endurance/economics.js';
import { SLICE_NODES, SLICE_TOKENS } from '../../workspace/runner/slice.js';
import { BASELINE_MAX_TURNS, TOOL_RESULT_MAX_CHARS, runBaselineTask } from './baselineArm.js';
import { TASKS, selectTasks, validateTask } from './catalog.js';
import { comparisons, summarize, taskRow } from './metrics.js';
import { SCOPE_CLOUD_PLAN } from './models.js';
import { answerCheck } from './research.js';
import { SCOPE_BUDGET, runScopeTask } from './scopeArm.js';
import { createWorkspace, objectiveCheck, osSandboxStatus } from './workspace.js';

// Task benchmark: does Scope, with the graph as the agent's memory and local
// models doing the steps, complete real tasks at a fraction of what the
// standard cloud-agent loop costs? Every ready task is run by every arm and
// judged by an objective check (for code, the fixture's own tests), never by
// what a model says.
//
//   --dry (default)  scripted models for every arm: the harness, the runner,
//                    the sandbox, the pricing and the checks all run for real,
//                    for $0, with no model and no key. This is what CI runs.
//   --live-local     the Scope local arm against the real local model
//                    (Ollama). No key, no spend; not run in CI.
//   --live           every arm against real models. Needs
//                    PLATFORM_ANTHROPIC_API_KEY and an explicit --max-usd of
//                    at most $5; refuses otherwise.

const here = dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = join(here, '../../../benchmarks/results');

export const ARMS = {
  scope_local: { name: 'scope_local', kind: 'scope', policy: 'local_only' },
  scope_local_cloud: { name: 'scope_local_cloud', kind: 'scope', policy: 'local_cloud' },
  baseline_sonnet: { name: 'baseline_sonnet', kind: 'baseline', model: 'claude-sonnet-5' },
  baseline_opus: { name: 'baseline_opus', kind: 'baseline', model: 'claude-opus-5' },
};
export const DEFAULT_ARMS = Object.keys(ARMS);
export const MODES = ['dry', 'live', 'live-local'];

export function liveRefusal({ mode, maxUsd, env = process.env }) {
  if (mode !== 'live') return null;
  if (!env.PLATFORM_ANTHROPIC_API_KEY) {
    return 'A live run needs PLATFORM_ANTHROPIC_API_KEY in the environment. Refusing to run: there is no default key; a dry run (the default) needs none.';
  }
  if (maxUsd == null) return `A live run needs an explicit --max-usd (at most ${LIVE_MAX_USD}). Refusing to run without a cap.`;
  if (!(maxUsd > 0) || maxUsd > LIVE_MAX_USD) return `--max-usd must be above 0 and at most ${LIVE_MAX_USD}, not ${maxUsd}.`;
  return null;
}

// The assumptions every number in the report rests on, written into it.
export function assumptions(mode) {
  return {
    mode,
    tokens: mode === 'dry'
      ? 'counted from the prompts actually built, at four characters a token (the corpus counts nodes the same way)'
      : 'as the model reported them; prompt sizes for the curve are the same four-characters-a-token estimate when a model reports none',
    replies: mode === 'dry' ? 'scripted: both arms play the same capability calls in the same order (catalog.js dry.actions)' : 'chosen by the models',
    completion: 'objective only: the task check (for code, the fixture’s test script with its original tests restored, run in the OS sandbox on the result; for research, the final answer against the task’s key, with every citation resolving to an ingested paper)',
    prices: 'USD per million tokens from lib/anthropic.js; cache writes at 1.25x input, cache reads at 0.1x input',
    baseline: {
      loop: 'full transcript: every turn re-sends the system prompt, the tool list and the whole conversation; one tool call per turn',
      caching: 'cache breakpoints on the previous and the new user turn, so the re-sent prefix is read at 0.1x; every turn assumed inside the cache lifetime (generous to the baseline)',
      toolResultMaxChars: TOOL_RESULT_MAX_CHARS,
      maxTurns: BASELINE_MAX_TURNS,
      contextWindowTokens: BASELINE_WINDOW_TOKENS,
    },
    scope: {
      runner: 'executeRun with the registered plug-ins, the run sandbox and the OS sandbox; agent level sandboxed, role Debugger (code tasks) or Researcher (research tasks)',
      memory: `the graph: each step reads one packed slice of at most ${SLICE_TOKENS} tokens and ${SLICE_NODES} nodes, never a transcript`,
      localCost: 'local model calls cost $0 (electricity and hardware not counted)',
      cloud: `scope_local_cloud runs on the ${SCOPE_CLOUD_PLAN} plan's rules: planning and hard steps may use the platform model it would pick, priced without caching`,
      budget: SCOPE_BUDGET,
    },
  };
}

async function createBenchmarkOwner(db) {
  // A throwaway account nobody can sign in to: the hash is not a hash.
  const email = `task-benchmark+${randomUUID()}@example.invalid`;
  const { rows } = await db.query("INSERT INTO users (email, password_hash) VALUES ($1, 'no-login:task-benchmark') RETURNING id", [email]);
  return rows[0].id;
}

function errorRow(task, arm, err) {
  return {
    task: task.id,
    kind: task.kind,
    arm: arm.name,
    armKind: arm.kind,
    completed: false,
    claimedDone: false,
    runStatus: 'harness_error',
    runError: String(err?.message ?? err).slice(0, 500),
    check: null,
    costUsd: 0,
    wallMs: 0,
    steps: 0,
    actions: 0,
    modelCalls: 0,
    cloudCalls: 0,
    tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    context: { firstStepPromptTokens: null, lastStepPromptTokens: null, maxStepPromptTokens: null, growthTokensPerStep: null },
    perCall: [],
  };
}

function pendingEntry(task) {
  return { id: task.id, kind: task.kind, title: task.title, status: 'pending', reason: task.pending.reason, readyWhen: task.pending.readyWhen, check: task.check?.description ?? null };
}

export async function runTaskBenchmark({
  tasks = TASKS,
  mode = 'dry',
  arms = DEFAULT_ARMS,
  maxUsd = null,
  apiKey,
  db = getPool(),
  ownerId = null,
  sandbox,
  keepWorkspace = false,
  log = () => {},
}) {
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}, not ${mode}`);
  const unknown = arms.filter((name) => !ARMS[name]);
  if (unknown.length) throw new Error(`unknown arm: ${unknown.join(', ')}`);
  if (mode === 'live') {
    const refusal = liveRefusal({ mode, maxUsd, env: { PLATFORM_ANTHROPIC_API_KEY: apiKey } });
    if (refusal) throw new Error(refusal);
  }
  if (mode === 'live-local' && arms.some((name) => name !== 'scope_local')) {
    throw new Error('a live-local run uses the local model only, so it runs the scope_local arm alone');
  }
  for (const task of tasks) {
    const problems = validateTask(task);
    if (problems.length) throw new Error(`task ${task?.id}: ${problems.join('; ')}`);
  }
  // Model-written code (and in a dry run, the scripted fixes) only ever runs
  // inside the OS sandbox, so without one there is nothing to check with.
  if (!sandbox) {
    const status = await osSandboxStatus();
    if (!status.available) throw new Error(`the task checks run in the OS sandbox, and there is none here (${status.reason})`);
  }

  const chosen = arms.map((name) => ARMS[name]);
  const cap = new SpendCap(mode === 'live' ? maxUsd : Infinity);
  const workspace = createWorkspace();
  const createdOwner = ownerId == null;
  const owner = ownerId ?? (await createBenchmarkOwner(db));
  const rows = [];
  const pending = [];
  const started = new Date();
  try {
    for (const task of tasks) {
      if (task.status === 'pending') {
        pending.push(pendingEntry(task));
        continue;
      }
      // The arms run one after another, so their wall clocks are not shared
      // with each other. The checks are not timed and run after them, also
      // one at a time: every OS-sandboxed process runs as the same user, and
      // the per-user process limit is shared, so concurrent `node --test`
      // runs can starve each other of threads and hang.
      const finished = [];
      for (const arm of chosen) {
        if (cap.stopped) {
          finished.push({ arm, row: { ...errorRow(task, arm, 'the spend cap was reached before this task started'), runStatus: 'skipped_cap' } });
          continue;
        }
        try {
          const result = arm.kind === 'scope'
            ? await runScopeTask({ task, arm, workspace, ownerId: owner, db, mode, cap, apiKey })
            : await runBaselineTask({ task, arm, workspace, mode, cap, apiKey, ownerId: owner, db });
          finished.push({ arm, result });
        } catch (err) {
          finished.push({ arm, row: errorRow(task, arm, err) });
        }
      }
      for (const { arm, result, row: early } of finished) {
        let row = early;
        if (!row) {
          try {
            const check = task.check.kind === 'answer'
              ? await answerCheck(task, { answer: result.answer, ownerId: owner, project: result.project, db })
              : await objectiveCheck(task, { resultDir: result.resultDir, workspace, label: arm.name, ...(sandbox ? { sandbox } : {}) });
            row = taskRow({ task, arm, result: { ...result, check } });
          } catch (err) {
            row = errorRow(task, arm, err);
          }
        }
        rows.push(row);
        log(`${task.id} ${row.arm}: ${row.completed ? 'completed' : 'not completed'} (${row.runStatus}) $${row.costUsd.toFixed(4)} ${row.wallMs}ms ${row.steps} steps`);
      }
    }
  } finally {
    // The benchmark's account, agents, runs and graph nodes go with the
    // account (every table cascades from users).
    if (createdOwner) await db.query('DELETE FROM users WHERE id = $1', [owner]).catch(() => {});
    if (!keepWorkspace) workspace.remove();
  }

  const totals = summarize(rows, arms);
  return {
    benchmark: 'tasks',
    mode,
    ranAt: started.toISOString(),
    durationMs: Date.now() - started.getTime(),
    maxUsd: mode === 'live' ? maxUsd : null,
    spentUsd: mode === 'live' ? cap.spentUsd : 0,
    pricedUsd: rows.reduce((total, row) => total + row.costUsd, 0),
    partial: Boolean(cap.stopped),
    stopped: cap.stopped,
    arms: chosen,
    assumptions: assumptions(mode),
    totals,
    comparisons: comparisons(totals, chosen),
    tasks: rows,
    pending,
    harnessErrors: rows.filter((row) => row.runStatus === 'harness_error').map((row) => ({ task: row.task, arm: row.arm, error: row.runError })),
    workspace: keepWorkspace ? workspace.root : null,
  };
}

const usd = (value) => (value == null ? '–' : `$${value.toFixed(4)}`);
const num = (value) => (value == null ? '–' : Math.round(value).toLocaleString('en-US'));
const ratio = (value) => (value == null ? '–' : value === Infinity ? '∞' : `${value.toFixed(1)}x`);

export function formatTable(report) {
  const lines = [
    `Task benchmark (${report.mode}) — ${report.mode === 'dry' ? 'priced at' : 'spent'} ${usd(report.mode === 'live' ? report.spentUsd : report.pricedUsd)}` +
      `${report.mode === 'dry' ? ' (dry: nothing was spent)' : ''}${report.partial ? ' — PARTIAL: spend cap reached' : ''}`,
    '',
    '| task | arm | done | $ | wall s | steps | calls | in | cache write | cache read | out | step ctx first→last |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of report.tasks) {
    const done = row.completed ? 'yes' : row.claimedDone ? 'NO (claimed)' : row.runStatus === 'harness_error' ? 'error' : 'no';
    lines.push(
      `| ${row.task} | ${row.arm} | ${done} | ${usd(row.costUsd)} | ${(row.wallMs / 1000).toFixed(1)} | ${row.steps} | ${row.modelCalls} | ` +
        `${num(row.tokens.input)} | ${num(row.tokens.cacheWrite)} | ${num(row.tokens.cacheRead)} | ${num(row.tokens.output)} | ` +
        `${num(row.context.firstStepPromptTokens)}→${num(row.context.lastStepPromptTokens)} |`
    );
  }
  lines.push(
    '',
    '| arm | completed | total $ | $ / completed | wall s | steps | max step ctx | ctx growth / step |',
    '|---|---|---|---|---|---|---|---|'
  );
  for (const [name, arm] of Object.entries(report.totals)) {
    lines.push(
      `| ${name} | ${arm.completed}/${arm.tasks} | ${usd(arm.costUsd)} | ${usd(arm.costPerCompletedUsd)} | ${(arm.wallMs / 1000).toFixed(1)} | ${arm.steps} | ` +
        `${num(arm.maxStepPromptTokens)} | ${arm.meanGrowthTokensPerStep == null ? '–' : `${arm.meanGrowthTokensPerStep.toFixed(0)} tok`} |`
    );
  }
  const pairs = Object.entries(report.comparisons);
  if (pairs.length) {
    lines.push('');
    for (const [name, comparison] of pairs) {
      lines.push(`- ${name}: a completed task costs ${ratio(comparison.baselineCostPerCompletedOverScope)} as much on the baseline`);
    }
  }
  if (report.pending.length) {
    lines.push('', 'Pending acceptance gates (listed, not run, not failures):');
    for (const entry of report.pending) lines.push(`- ${entry.id} (${entry.kind}): ${entry.reason}. Ready when ${entry.readyWhen}.`);
  }
  if (report.harnessErrors.length) {
    lines.push('', 'Harness errors:');
    for (const failure of report.harnessErrors) lines.push(`- ${failure.task} ${failure.arm}: ${failure.error}`);
  }
  lines.push('', 'Prices: lib/anthropic.js, cache write 1.25x / read 0.1x input; local calls $0. Completion is the objective check only. Assumptions are in the JSON.');
  return lines.join('\n');
}

export function toJson(report) {
  return JSON.stringify(report, (key, value) => (value === Infinity ? 'unbounded' : value), 2);
}

const HELP = `usage: npm run benchmark:tasks -- [options]
  --dry               scripted models, $0, no key (default; what CI runs)
  --live-local        the scope_local arm on the real local model (Ollama); no key, no spend
  --live              real models for every arm; needs PLATFORM_ANTHROPIC_API_KEY and --max-usd
  --max-usd <n>       live only: stop once the run has spent this much (required, at most ${LIVE_MAX_USD})
  --task <id,...>     only these tasks
  --kind <kind,...>   only these kinds (code, kicad, research, physics, cad)
  --arms <name,...>   ${DEFAULT_ARMS.join(', ')} (default: all)
  --out <file>        where to write the JSON (default benchmarks/results/tasks-<timestamp>.json)
  --keep              keep the scratch workspace (projects, results, checks) for inspection
  --list              list the tasks, ready and pending, and exit

Reads DATABASE_URL for the runner's tables (migrated first); the benchmark
uses a throwaway account and removes it afterwards.`;

export function parseArgs(argv) {
  const args = { mode: 'dry', maxUsd: null, tasks: null, kinds: null, arms: null, out: null, keep: false, list: false, help: false };
  const modes = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const value = () => {
      const next = inline ?? argv[++i];
      if (next == null) throw new Error(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case '--dry': modes.add('dry'); break;
      case '--live': modes.add('live'); break;
      case '--live-local': modes.add('live-local'); break;
      case '--max-usd': {
        const raw = value();
        args.maxUsd = Number(raw);
        if (!(args.maxUsd > 0) || args.maxUsd > LIVE_MAX_USD) throw new Error(`--max-usd must be above 0 and at most ${LIVE_MAX_USD}, not ${raw}`);
        break;
      }
      case '--task': args.tasks = value().split(','); break;
      case '--kind': args.kinds = value().split(','); break;
      case '--arms': {
        args.arms = value().split(',');
        const unknown = args.arms.filter((name) => !ARMS[name]);
        if (unknown.length) throw new Error(`unknown arm: ${unknown.join(', ')}`);
        break;
      }
      case '--out': args.out = resolve(value()); break;
      case '--keep': args.keep = true; break;
      case '--list': args.list = true; break;
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (modes.size > 1) throw new Error('choose one of --dry, --live-local or --live');
  args.mode = [...modes][0] ?? 'dry';
  if (args.mode !== 'live' && args.maxUsd != null) throw new Error('--max-usd applies to --live only; dry and live-local runs spend nothing');
  args.arms ??= args.mode === 'live-local' ? ['scope_local'] : DEFAULT_ARMS;
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const tasks = selectTasks(TASKS, { ids: args.tasks, kinds: args.kinds });
  if (args.list) {
    for (const task of tasks) console.log(`${task.status.padEnd(8)} ${task.kind.padEnd(9)} ${task.id} — ${task.title}`);
    return 0;
  }
  const refusal = liveRefusal({ mode: args.mode, maxUsd: args.maxUsd });
  if (refusal) {
    console.error(refusal);
    return 2;
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set: the Scope arms run on the engine’s own tables.');
    return 2;
  }

  const pool = getPool();
  try {
    await migrate(pool, { log: () => {} });
    const report = await runTaskBenchmark({
      tasks,
      mode: args.mode,
      arms: args.arms,
      maxUsd: args.maxUsd,
      apiKey: args.mode === 'live' ? process.env.PLATFORM_ANTHROPIC_API_KEY : undefined,
      db: pool,
      keepWorkspace: args.keep,
      log: (line) => console.error(line),
    });
    // The file first, so a broken pipe on stdout cannot lose a paid run's report.
    const file = args.out ?? join(RESULTS_DIR, `tasks-${report.ranAt.replace(/[:.]/g, '-')}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, toJson(report));
    console.error(`report written to ${file}`);
    console.log(formatTable(report));
    return report.harnessErrors.length ? 1 : 0;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
