import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodePath } from '../judge.js';

// Endurance scenarios: one working day each, written as the turns a person
// would actually type, where later turns lean on earlier answers. They live
// under benchmarks/sessions/<plugin>/<name>.json, one directory per discipline
// plug-in, so a new plug-in brings its own sessions without touching the
// harness.

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SESSIONS_DIR = join(here, '../../../benchmarks/sessions');

export const STATUSES = ['ready', 'pending'];
export const TURN_KINDS = ['lookup', 'hard', 'followup'];
// The platform-paid plans: the ones whose weekly allowance is the equal-dollar
// budget. Key Pro spends the user's own key and Free never reaches the cloud.
export const SCENARIO_PLANS = ['engineer', 'student'];
export const MIN_TURNS = 30;
export const MAX_TURNS = 50;

// What a scenario runs against. A corpus is nodes already ingested for an
// account in the database the harness points at; a reference is a public
// project named by URL and license that no shipped plug-in can ingest yet, so
// its scenarios wait as pending. When a plug-in lands, its reference fixtures
// are ingested into a corpus and the scenario flips to ready; a new kind of
// fixture is one more entry here.
export const FIXTURE_KINDS = {
  corpus: {
    runnable: true,
    problems: (fixture, scenario) => (scenario.ownerEmail ? [] : ['a corpus fixture needs ownerEmail']),
  },
  reference: {
    runnable: false,
    problems: (fixture) => [
      ...(typeof fixture.url === 'string' && /^https:\/\//.test(fixture.url) ? [] : ['a reference fixture needs an https url']),
      ...(typeof fixture.license === 'string' && fixture.license.trim() ? [] : ['a reference fixture needs its license']),
    ],
  },
};

const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const REGEX_TERM = /^\/(.+)\/([a-z]*)$/;

// A mustMention term is plain text matched case-insensitively, or a /regex/
// with optional flags for answers that can phrase a fact more than one way.
export function compileTerm(term) {
  const regex = REGEX_TERM.exec(term);
  if (!regex) {
    const needle = term.toLowerCase();
    return (answer) => answer.toLowerCase().includes(needle);
  }
  const pattern = new RegExp(regex[1], regex[2].includes('i') ? regex[2] : `${regex[2]}i`);
  return (answer) => pattern.test(answer);
}

function turnProblems(turn, index) {
  const at = `turn ${index + 1}`;
  const problems = [];
  if (!turn || typeof turn !== 'object') return [`${at}: not an object`];
  if (!isText(turn.ask)) problems.push(`${at}: ask is required`);
  if (!TURN_KINDS.includes(turn.kind)) problems.push(`${at}: kind must be one of ${TURN_KINDS.join(', ')}`);
  if (!Array.isArray(turn.mustMention) || turn.mustMention.length === 0 || !turn.mustMention.every(isText)) {
    problems.push(`${at}: mustMention must list at least one term`);
  } else {
    for (const term of turn.mustMention) {
      try {
        compileTerm(term);
      } catch (err) {
        problems.push(`${at}: mustMention ${term} is not a valid pattern (${err.message})`);
      }
    }
  }
  if (!Array.isArray(turn.mustCite)) problems.push(`${at}: mustCite must be a list (empty when the answer rests on earlier turns)`);
  else {
    for (const cite of turn.mustCite) {
      if (!cite || !isText(cite.project) || !isText(cite.path)) problems.push(`${at}: every mustCite needs a project and a path`);
    }
  }
  return problems;
}

// Everything wrong with one scenario, as sentences; empty when it is valid.
// Ready scenarios must be runnable today and long enough to be a working day;
// pending ones are held to the same turn shape so they can become acceptance
// gates without being rewritten.
export function validateScenario(scenario, { plugin } = {}) {
  if (!scenario || typeof scenario !== 'object') return ['not an object'];
  const problems = [];
  if (!isText(scenario.id)) problems.push('id is required');
  if (!isText(scenario.plugin)) problems.push('plugin is required');
  else if (plugin && scenario.plugin !== plugin) problems.push(`plugin ${scenario.plugin} does not match its directory ${plugin}`);
  if (!Array.isArray(scenario.plugins) || scenario.plugins.length === 0 || !scenario.plugins.every(isText)) {
    problems.push('plugins must list the source plug-ins the session needs');
  }
  if (!STATUSES.includes(scenario.status)) problems.push(`status must be one of ${STATUSES.join(', ')}`);
  if (!SCENARIO_PLANS.includes(scenario.plan)) problems.push(`plan must be one of ${SCENARIO_PLANS.join(', ')}`);
  if (scenario.project !== undefined && !isText(scenario.project)) problems.push('project, when given, must be a repository name');

  const kind = FIXTURE_KINDS[scenario.fixture?.kind];
  if (!kind) problems.push(`fixture.kind must be one of ${Object.keys(FIXTURE_KINDS).join(', ')}`);
  else {
    problems.push(...kind.problems(scenario.fixture, scenario));
    if (scenario.status === 'ready' && !kind.runnable) problems.push(`a ready scenario needs a runnable fixture, not ${scenario.fixture.kind}`);
  }

  if (!Array.isArray(scenario.turns)) problems.push('turns must be a list');
  else {
    if (scenario.turns.length < MIN_TURNS || scenario.turns.length > MAX_TURNS) {
      problems.push(`a working day is ${MIN_TURNS}–${MAX_TURNS} turns, not ${scenario.turns.length}`);
    }
    scenario.turns.forEach((turn, i) => problems.push(...turnProblems(turn, i)));
  }
  return problems;
}

// Reads every scenario under `dir`, one subdirectory per plug-in. Invalid
// files are reported, never silently dropped, and ids must be unique so a
// result can always be traced back to its file.
export function loadScenarios(dir = DEFAULT_SESSIONS_DIR) {
  const scenarios = [];
  const errors = [];
  const seen = new Map();
  for (const plugin of readdirSync(dir).sort()) {
    const pluginDir = join(dir, plugin);
    if (!statSync(pluginDir).isDirectory()) continue;
    for (const name of readdirSync(pluginDir).sort()) {
      if (!name.endsWith('.json')) continue;
      const file = join(pluginDir, name);
      let scenario;
      try {
        scenario = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        errors.push({ file, problems: [`not valid JSON: ${err.message}`] });
        continue;
      }
      const problems = validateScenario(scenario, { plugin });
      if (seen.has(scenario.id)) problems.push(`id ${scenario.id} is also used by ${basename(seen.get(scenario.id))}`);
      if (problems.length) {
        errors.push({ file, problems });
        continue;
      }
      seen.set(scenario.id, file);
      scenarios.push({ ...scenario, file });
    }
  }
  return {
    scenarios,
    ready: scenarios.filter((s) => s.status === 'ready'),
    pending: scenarios.filter((s) => s.status === 'pending'),
    errors,
  };
}

// Fraction of the expected terms the answer contains, and which ones.
export function mentionScore(answer, mustMention) {
  if (!mustMention?.length) return { score: null, matched: [] };
  const text = answer ?? '';
  const matched = mustMention.filter((term) => compileTerm(term)(text));
  return { score: matched.length / mustMention.length, matched };
}

// A cited file is matched by project and path the way the retrieval benchmark
// matches it: the whole path, or a suffix on a directory boundary. A path that
// starts with * matches any file ending in what follows, for fixtures whose
// exact file names are pinned only once a plug-in ingests them.
export function citeMatches(node, cite) {
  if (node.project !== cite.project) return false;
  const path = nodePath(node);
  if (path == null) return false;
  if (cite.path.startsWith('*')) return path.endsWith(cite.path.slice(1));
  return path === cite.path || path.endsWith(`/${cite.path}`);
}

// Fraction of the files a correct answer needs that were in front of the model.
export function citeCoverage(nodes, mustCite) {
  if (!mustCite?.length) return null;
  const found = mustCite.filter((cite) => nodes.some((node) => citeMatches(node, cite)));
  return found.length / mustCite.length;
}

export function describeNode(node) {
  return { project: node.project ?? null, path: nodePath(node), id: node.id };
}
