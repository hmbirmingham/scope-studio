import 'dotenv/config';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPool } from '../db/pool.js';
import { weeklyAllowanceUsd } from '../billing/plans.js';
import {
  ARMS,
  BASELINE_ARMS,
  BASELINE_CONTEXT_CAP_TOKENS,
  BASELINE_WINDOW_TOKENS,
  DEFAULT_ARMS,
  UpstreamError,
  dryAnswerChunks,
} from './endurance/arms.js';
import {
  DRY,
  LIVE_MAX_USD,
  PASS_QUALITY_RATIO,
  PASS_TURNS_RATIO,
  SpendCap,
  mean,
  qualityRatio,
  turnsRatio,
  turnsUntilBudget,
  verdict,
} from './endurance/economics.js';
import { DEFAULT_SESSIONS_DIR, loadScenarios } from './endurance/scenarios.js';

// Session endurance benchmark: does a continuous working session in Scope
// last longer than the same session in a cloud app, at comparable quality,
// and does that hold per plug-in? Each ready scenario is played turn by turn
// by every arm — Scope's own pipeline, and cloud-app baselines on Sonnet and
// Opus that re-send the whole transcript — and the turns each could afford on
// the plan's weekly allowance are compared.
//
// --dry (the default) runs real retrieval and real prompt building against
// stand-in models and prices every prompt from its tokens. --live spends real
// money, needs PLATFORM_ANTHROPIC_API_KEY, and never more than --max-usd.

const here = dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = join(here, '../../benchmarks/results');

export function liveRefusal(env = process.env) {
  return env.PLATFORM_ANTHROPIC_API_KEY
    ? null
    : 'A live run needs PLATFORM_ANTHROPIC_API_KEY in the environment. Refusing to run: there is no default key, and a dry run (the default) needs none.';
}

// Starts the stand-in models a dry run talks to and points the engine at them
// for the duration. Embeddings still go to the real local Ollama when it is
// up, so retrieval is the real thing; without it, retrieval runs lexical-only
// as it does in production.
export async function withDryServices(fn) {
  const { startFakeOllama } = await import('../../test/fakeOllama.js');
  const { startFakeAnthropic } = await import('../../test/fakeAnthropic.js');
  const realOllama = process.env.OLLAMA_URL || 'http://localhost:11434';
  const ollama = await startFakeOllama({ embedUrl: realOllama });
  const anthropic = await startFakeAnthropic();
  ollama.state.tokens = dryAnswerChunks();
  anthropic.state.text = dryAnswerChunks();
  const saved = { OLLAMA_URL: process.env.OLLAMA_URL, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL };
  process.env.OLLAMA_URL = ollama.url;
  process.env.ANTHROPIC_BASE_URL = anthropic.url;
  try {
    return await fn({ ollama, anthropic });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await ollama.close();
    await anthropic.close();
  }
}

// The plan's credential rules need some key to decide that a platform answer
// is possible. A dry run borrows the stand-in's own test key, so the only fake
// key lives with the fakes, and assertDryEndpoint in endurance/arms.js refuses
// to send it anywhere but the stand-in.
async function dryPlatformKey() {
  const { FAKE_ANTHROPIC_KEY } = await import('../../test/fakeAnthropic.js');
  return FAKE_ANTHROPIC_KEY;
}

// Exit status when an upstream error cut an arm short: the run is not a
// clean result, but its report was still printed and, with --out, written.
export const EXIT_UPSTREAM_ERROR = 3;

export async function ownerByEmail(email, pool = getPool()) {
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  return rows[0]?.id ?? null;
}

function armSummary(rows, budgetUsd, dry) {
  const costs = rows.map((row) => row.costUsd);
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  const budget = turnsUntilBudget(costs, budgetUsd);
  const byKind = {};
  for (const row of rows) (byKind[row.kind] ??= []).push(row);
  return {
    turnsRun: rows.length,
    totalCostUsd: total,
    meanCostPerTurnUsd: rows.length ? total / rows.length : null,
    turnsUntilBudget: budget.turns,
    projected: budget.projected,
    unbounded: budget.unbounded,
    meanQuality: dry ? DRY : mean(rows.map((row) => row.quality)),
    meanCiteCoverage: mean(rows.map((row) => row.citeCoverage)),
    cloudTurns: rows.filter((row) => row.decision === 'cloud').length,
    blockedTurns: rows.filter((row) => row.blocked).length,
    meanLatencyMs: mean(rows.map((row) => row.latencyMs)),
    byKind: Object.fromEntries(
      Object.entries(byKind).map(([kind, group]) => [
        kind,
        {
          turns: group.length,
          meanCostUsd: mean(group.map((row) => row.costUsd)),
          meanQuality: dry ? DRY : mean(group.map((row) => row.quality)),
          meanCiteCoverage: mean(group.map((row) => row.citeCoverage)),
        },
      ])
    ),
  };
}

// Why Scope may have lost a turn, as a first guess for whoever triages it:
// the evidence never reached the prompt, a hard question stayed on the local
// model, or the model that answered fell short with the evidence in hand.
export function suggestedCause(row, turn) {
  if (row.citeCoverage != null && row.citeCoverage < 1) return 'retrieval_miss';
  if (row.decision === 'local' && (turn.kind === 'hard' || row.difficulty)) return 'routing_should_have_escalated';
  if (row.decision === 'local') return 'local_model_weakness';
  return 'cloud_answer_gap';
}

// Every turn Scope did worse than a baseline on. Live runs compare answer
// quality; dry runs have no answers, so they compare citation coverage, which
// still surfaces retrieval misses.
export function triageTurns(scenario, byArm, dry) {
  const basis = dry ? 'citeCoverage (dry)' : 'quality';
  const metric = (row) => (dry ? row?.citeCoverage : row?.quality);
  const losses = [];
  for (const row of byArm.scope ?? []) {
    const scope = metric(row);
    if (typeof scope !== 'number') continue;
    const baselines = {};
    let lost = false;
    for (const name of BASELINE_ARMS) {
      const other = metric(byArm[name]?.[row.turn - 1]);
      if (typeof other !== 'number') continue;
      baselines[name] = other;
      if (scope < other) lost = true;
    }
    if (!lost) continue;
    const turn = scenario.turns[row.turn - 1];
    losses.push({
      turn: row.turn,
      kind: row.kind,
      ask: row.ask,
      basis,
      scope,
      baselines,
      expected: turn.mustCite,
      selected: row.selected.map(({ project, path }) => ({ project, path })),
      model: row.model,
      decision: row.decision,
      routeReason: row.routeReason,
      difficulty: row.difficulty,
      suggestedCause: suggestedCause(row, turn),
    });
  }
  return losses;
}

function scenarioResult(scenario, byArm, { dry, triage, halted = {} }) {
  const budgetUsd = weeklyAllowanceUsd(scenario.plan);
  const arms = Object.fromEntries(
    Object.entries(byArm).map(([name, rows]) => [
      name,
      { ...armSummary(rows, budgetUsd, dry), ...(halted[name] ? { stoppedBy: halted[name] } : {}), turns: rows },
    ])
  );
  const comparisons = {};
  if (arms.scope) {
    for (const name of BASELINE_ARMS) {
      if (!arms[name]) continue;
      const turns = turnsRatio(arms.scope.turnsUntilBudget, arms[name].turnsUntilBudget);
      const quality = dry
        ? null
        : qualityRatio(byArm.scope.map((row) => row.quality), byArm[name].map((row) => row.quality));
      comparisons[name] = { turnsRatio: turns, qualityRatio: dry ? DRY : quality, ...verdict({ turnsRatio: turns, qualityRatio: quality, dry }) };
    }
  }
  const verdicts = Object.values(comparisons).map((c) => c.verdict);
  // The spend cap stops every arm at the same turn; an upstream error stops
  // only the arm it hit, so the arms no longer cover the same turns and no
  // live verdict is drawn from them.
  const interrupted = Object.keys(halted).length > 0;
  const overall = verdicts.length === 0 || (interrupted && !dry)
    ? 'incomplete'
    : dry ? DRY
      : verdicts.every((v) => v === 'pass') ? 'pass'
        : verdicts.some((v) => v === 'fail') ? 'fail' : 'incomplete';
  return {
    id: scenario.id,
    plugin: scenario.plugin,
    plugins: scenario.plugins,
    plan: scenario.plan,
    project: scenario.project ?? null,
    budgetUsd,
    turnsPlanned: scenario.turns.length,
    arms,
    comparisons,
    verdict: overall,
    ...(triage ? { triage: triageTurns(scenario, byArm, dry) } : {}),
  };
}

// Cost per turn and verdicts rolled up per plug-in, the unit the product sells.
function pluginSummary(results) {
  const plugins = {};
  for (const result of results) {
    if (!result.arms) continue;
    const entry = (plugins[result.plugin] ??= { scenarios: [], costPerTurnUsd: {}, verdicts: {} });
    entry.scenarios.push(result.id);
    entry.verdicts[result.id] = result.verdict;
    for (const [name, arm] of Object.entries(result.arms)) {
      (entry.costPerTurnUsd[name] ??= []).push(...arm.turns.map((row) => row.costUsd));
    }
  }
  for (const entry of Object.values(plugins)) {
    entry.costPerTurnUsd = Object.fromEntries(Object.entries(entry.costPerTurnUsd).map(([name, costs]) => [name, mean(costs)]));
  }
  return plugins;
}

function pendingEntry(scenario) {
  return {
    id: scenario.id,
    plugin: scenario.plugin,
    plugins: scenario.plugins,
    turns: scenario.turns.length,
    fixture: scenario.fixture,
    reason: `waiting on the ${scenario.plugins.join(' + ')} plug-in to ingest its ${scenario.fixture.kind} fixture`,
  };
}

// Plays every ready scenario through every arm, turn by turn and arm by arm,
// so a run stopped by the spend cap leaves every arm at the same turn.
// Pending scenarios are listed, never run. An upstream error (a 429, a 529, a
// dropped connection) stops only the arm it hit, for the rest of that
// scenario: the turns it already ran are kept and the report is marked
// partial, since in a live run those turns were paid for.
export async function runEndurance({
  scenarios,
  mode = 'dry',
  arms = DEFAULT_ARMS,
  maxUsd = null,
  triage = false,
  platformKey,
  resolveOwner = (scenario) => ownerByEmail(scenario.ownerEmail),
  log = () => {},
}) {
  if (!['dry', 'live'].includes(mode)) throw new Error(`mode must be dry or live, not ${mode}`);
  if (maxUsd != null && (!(maxUsd > 0) || maxUsd > LIVE_MAX_USD)) throw new Error(`--max-usd must be above 0 and at most ${LIVE_MAX_USD}`);
  const unknown = arms.filter((name) => !ARMS[name]);
  if (unknown.length) throw new Error(`unknown arm: ${unknown.join(', ')}`);
  const dry = mode === 'dry';
  if (!dry && !platformKey) throw new Error(liveRefusal({}));
  const key = dry ? await dryPlatformKey() : platformKey;

  // A live run is always capped. A dry run spends nothing, so it runs every
  // scenario unless a cap is asked for — which previews how far a live run on
  // that cap would get.
  const ceiling = maxUsd ?? (dry ? null : LIVE_MAX_USD);
  const cap = new SpendCap(ceiling ?? Infinity);
  const results = [];
  const pending = [];
  const upstreamErrors = [];
  for (const scenario of scenarios) {
    if (scenario.status === 'pending') {
      pending.push(pendingEntry(scenario));
      continue;
    }
    if (cap.stopped) {
      results.push({ id: scenario.id, plugin: scenario.plugin, skipped: 'the spend cap was reached before this scenario started' });
      continue;
    }
    const ownerId = await resolveOwner(scenario);
    if (!ownerId) {
      results.push({ id: scenario.id, plugin: scenario.plugin, skipped: `no account ${scenario.ownerEmail} in this database` });
      continue;
    }

    const players = arms.map((name) => ARMS[name]({ scenario, ownerId, mode, cap, platformKey: key }));
    const byArm = Object.fromEntries(arms.map((name) => [name, []]));
    const cumulative = Object.fromEntries(arms.map((name) => [name, 0]));
    const halted = {};
    for (const [index, turn] of scenario.turns.entries()) {
      for (const player of players) {
        if (cap.stopped) break;
        if (halted[player.name]) continue;
        let row;
        try {
          row = await player.turn(turn, index);
        } catch (err) {
          if (!(err instanceof UpstreamError)) throw err;
          const failure = { scenario: scenario.id, arm: player.name, turn: index + 1, status: err.status, message: err.message };
          halted[player.name] = failure;
          upstreamErrors.push(failure);
          log(`${scenario.id} t${index + 1} ${player.name} stopped: upstream ${err.status ?? 'connection'} error: ${err.message}`);
          continue;
        }
        if (row.stopped) break;
        cumulative[player.name] += row.costUsd;
        byArm[player.name].push({ ...row, cumulativeCostUsd: cumulative[player.name] });
        log(`${scenario.id} t${index + 1} ${player.name} ${row.model ?? 'blocked'} ${row.routeReason} $${row.costUsd.toFixed(4)}`);
      }
      if (cap.stopped || Object.keys(halted).length === players.length) break;
    }
    results.push(scenarioResult(scenario, byArm, { dry, triage, halted }));
  }

  return {
    mode,
    ranAt: new Date().toISOString(),
    gate: { turnsRatio: PASS_TURNS_RATIO, qualityRatio: PASS_QUALITY_RATIO, budget: 'plan weekly allowance (weeklyAllowanceUsd)' },
    baseline: {
      context: 'every candidate retrieved for the turn not already in the transcript, cloud-tier floor',
      contextCapTokens: BASELINE_CONTEXT_CAP_TOKENS,
      windowTokens: BASELINE_WINDOW_TOKENS,
      caching: 'breakpoints on the previous and the new user turn; every turn assumed inside the cache lifetime',
    },
    maxUsd: ceiling,
    spentUsd: cap.spentUsd,
    partial: Boolean(cap.stopped) || upstreamErrors.length > 0,
    stopped: cap.stopped,
    upstreamErrors,
    scenarios: results,
    plugins: pluginSummary(results),
    pending,
  };
}

const usd = (value) => (value == null ? '–' : `$${value.toFixed(4)}`);
const ratio = (value) => (value == null ? '–' : value === Infinity ? '∞' : typeof value === 'number' ? `${value.toFixed(2)}x` : value);
const share = (value) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : value ?? '–');
const turns = (arm) => (arm.unbounded ? '∞' : arm.turnsUntilBudget == null ? '–' : `${arm.turnsUntilBudget}${arm.projected ? '*' : ''}`);

function partialReason(report) {
  const reasons = [];
  if (report.stopped || !report.upstreamErrors?.length) reasons.push('spend cap reached');
  if (report.upstreamErrors?.length) reasons.push('upstream error');
  return reasons.join(', ');
}

export function formatMarkdown(report) {
  const lines = [
    `Endurance benchmark (${report.mode}) — ${report.mode === 'dry' ? 'priced at' : 'spent'} ${usd(report.spentUsd)}` +
      `${report.maxUsd == null ? '' : ` of a ${usd(report.maxUsd)} cap`}${report.partial ? ` — PARTIAL: ${partialReason(report)}` : ''}`,
    '',
    '| scenario | arm | turns run | $/turn | turns on budget | vs sonnet | vs opus | quality | cite | verdict |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const result of report.scenarios) {
    if (result.skipped) {
      lines.push(`| ${result.id} | – | – | – | – | – | – | – | – | skipped: ${result.skipped} |`);
      continue;
    }
    for (const [name, arm] of Object.entries(result.arms)) {
      const isScope = name === 'scope';
      lines.push(
        `| ${result.id} | ${name} | ${arm.turnsRun}/${result.turnsPlanned} | ${usd(arm.meanCostPerTurnUsd)} | ${turns(arm)} | ` +
          `${isScope ? ratio(result.comparisons.baseline_sonnet?.turnsRatio) : ''} | ${isScope ? ratio(result.comparisons.baseline_opus?.turnsRatio) : ''} | ` +
          `${share(arm.meanQuality)} | ${share(arm.meanCiteCoverage)} | ${isScope ? result.verdict : ''} |`
      );
    }
  }
  lines.push('', `* projected from mean cost per turn. Budget: the plan's weekly allowance. Gate: ≥${PASS_TURNS_RATIO}x turns at ≥${PASS_QUALITY_RATIO * 100}% quality.`);
  const plugins = Object.entries(report.plugins);
  if (plugins.length) {
    lines.push('', '| plug-in | arm | $/turn |', '|---|---|---|');
    for (const [plugin, entry] of plugins) {
      for (const [name, cost] of Object.entries(entry.costPerTurnUsd)) lines.push(`| ${plugin} | ${name} | ${usd(cost)} |`);
    }
  }
  if (report.upstreamErrors?.length) {
    lines.push('', 'Stopped by upstream errors (turns before them are kept above):');
    for (const failure of report.upstreamErrors) {
      lines.push(`- ${failure.scenario} ${failure.arm} at turn ${failure.turn}: ${failure.status ?? 'connection'} ${failure.message}`);
    }
  }
  if (report.pending.length) {
    lines.push('', 'Pending (listed, not run):');
    for (const entry of report.pending) lines.push(`- ${entry.id} (${entry.plugin}, ${entry.turns} turns): ${entry.reason}`);
  }
  return lines.join('\n');
}

// Infinity has no JSON spelling; an unbounded ratio is written as a word.
export function toJson(report) {
  return JSON.stringify(report, (key, value) => (value === Infinity ? 'unbounded' : value), 2);
}

// Writes the file before printing, so a broken pipe on stdout cannot cost a
// paid run its report. Returns the exit status.
export function emitReport(report, { out = false, resultsDir = RESULTS_DIR, print = console.log, note = console.error } = {}) {
  if (out) {
    mkdirSync(resultsDir, { recursive: true });
    const file = join(resultsDir, `${report.ranAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, toJson(report));
    note(`report written to ${file}`);
  }
  print(formatMarkdown(report));
  print(`\n${toJson(report)}`);
  return report.upstreamErrors?.length ? EXIT_UPSTREAM_ERROR : 0;
}

const HELP = `usage: npm run endurance -- [options]
  --dry                 stand-in models, prices from token counts (default)
  --live                real models; needs PLATFORM_ANTHROPIC_API_KEY
  --max-usd <n>         stop every arm once the run has spent this much (live: default and maximum ${LIVE_MAX_USD};
                        dry: no cap unless given, to preview how far a live run would get)
  --scenario <id,...>   only these scenarios
  --plugin <name,...>   only these plug-ins
  --arms <name,...>     ${DEFAULT_ARMS.join(', ')} (default: all)
  --triage              list every turn Scope lost, with what it read and why it routed as it did
  --out                 also write the JSON report to benchmarks/results/<timestamp>.json
  --sessions <dir>      scenario directory (default benchmarks/sessions)
  --list                list scenarios, ready and pending, and exit

The markdown table and the JSON report always go to stdout. If an upstream
error (429, 529, dropped connection) stops an arm, the turns it ran are kept,
the partial report is still printed and written, and the exit status is ${EXIT_UPSTREAM_ERROR}.`;

export function parseArgs(argv) {
  const args = { mode: 'dry', maxUsd: null, scenarios: null, plugins: null, arms: DEFAULT_ARMS, triage: false, out: false, sessions: DEFAULT_SESSIONS_DIR, list: false, help: false };
  const modes = new Set();
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const value = () => inline ?? argv[++i];
    switch (flag) {
      case '--dry': modes.add('dry'); break;
      case '--live': modes.add('live'); break;
      case '--max-usd': {
        const raw = value();
        args.maxUsd = Number(raw);
        if (!(args.maxUsd > 0) || args.maxUsd > LIVE_MAX_USD) throw new Error(`--max-usd must be above 0 and at most ${LIVE_MAX_USD}, not ${raw}`);
        break;
      }
      case '--scenario': args.scenarios = value().split(','); break;
      case '--plugin': args.plugins = value().split(','); break;
      case '--arms': {
        args.arms = value().split(',');
        const unknown = args.arms.filter((name) => !ARMS[name]);
        if (unknown.length) throw new Error(`unknown arm: ${unknown.join(', ')}`);
        break;
      }
      case '--triage': args.triage = true; break;
      case '--out': args.out = true; break;
      case '--sessions': args.sessions = resolve(value()); break;
      case '--list': args.list = true; break;
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (modes.size > 1) throw new Error('choose one of --dry or --live');
  if (modes.has('live')) args.mode = 'live';
  return args;
}

export function selectScenarios(scenarios, { scenarios: ids, plugins }) {
  return scenarios.filter((s) => (!ids || ids.includes(s.id)) && (!plugins || plugins.includes(s.plugin)));
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const loaded = loadScenarios(args.sessions);
  for (const { file, problems } of loaded.errors) console.error(`${file}:\n  ${problems.join('\n  ')}`);
  if (loaded.errors.length) return 1;
  const chosen = selectScenarios(loaded.scenarios, args);
  if (args.list) {
    for (const s of chosen) console.log(`${s.status.padEnd(8)} ${s.plugin.padEnd(10)} ${s.id} (${s.turns.length} turns, ${s.plan})`);
    return 0;
  }
  if (args.mode === 'live') {
    const refusal = liveRefusal();
    if (refusal) {
      console.error(refusal);
      return 2;
    }
  }

  const pool = getPool();
  try {
    const run = () =>
      runEndurance({
        scenarios: chosen,
        mode: args.mode,
        arms: args.arms,
        maxUsd: args.maxUsd,
        triage: args.triage,
        platformKey: args.mode === 'live' ? process.env.PLATFORM_ANTHROPIC_API_KEY : undefined,
        log: (line) => console.error(line),
      });
    const report = args.mode === 'live' ? await run() : await withDryServices(run);
    try {
      report.commitHash = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      report.commitHash = null;
    }
    return emitReport(report, { out: args.out });
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
