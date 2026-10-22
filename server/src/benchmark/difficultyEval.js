import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { questionDifficulty } from '../routing/difficulty.js';

// Scores routing/difficulty.js against labelled questions: accuracy and a
// confusion matrix of easy (answer locally) against hard (worth the cloud).
// Two sets, reported apart: a held-out file written for this eval, and the
// turns of the endurance sessions, whose authors labelled each ask lookup,
// hard or follow-up. Follow-ups are left out: whether "now make it two per
// ten seconds" is hard depends on the turn before, which this rule never sees.

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DIFFICULTY_SET = join(here, '../../benchmarks/difficulty-eval.json');
export const DEFAULT_SESSIONS_DIR = join(here, '../../benchmarks/sessions');
export const LABELS = ['easy', 'hard'];

const SESSION_LABELS = { lookup: 'easy', hard: 'hard' };

export function loadHeldOut(path = DEFAULT_DIFFICULTY_SET) {
  const { queries } = JSON.parse(readFileSync(path, 'utf8'));
  for (const item of queries) {
    if (!LABELS.includes(item.label)) throw new Error(`difficulty eval: bad label ${item.label} for "${item.query}"`);
  }
  return queries;
}

// Plain lookups that share words with the hard patterns, kept apart from the
// held-out set: they were written after a review found the rule sending them
// to the cloud, so scoring them with the held-out set would flatter it.
export function loadAdversarialEasy(path = DEFAULT_DIFFICULTY_SET) {
  const { adversarial_easy: queries = [] } = JSON.parse(readFileSync(path, 'utf8'));
  return queries.map((query) => ({ query, label: 'easy' }));
}

function scenarioFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? scenarioFiles(join(dir, entry.name)) : entry.name.endsWith('.json') ? [join(dir, entry.name)] : []
  );
}

export function loadSessionTurns(dir = DEFAULT_SESSIONS_DIR) {
  return scenarioFiles(dir)
    .sort()
    .flatMap((file) => JSON.parse(readFileSync(file, 'utf8')).turns ?? [])
    .filter((turn) => SESSION_LABELS[turn.kind])
    .map((turn) => ({ query: turn.ask, label: SESSION_LABELS[turn.kind] }));
}

export function evaluateDifficulty(items, classify = questionDifficulty) {
  // confusion[actual][predicted]
  const confusion = { easy: { easy: 0, hard: 0 }, hard: { easy: 0, hard: 0 } };
  const misroutes = [];
  for (const item of items) {
    const reason = classify(item.query);
    const predicted = reason ? 'hard' : 'easy';
    confusion[item.label][predicted] += 1;
    if (predicted !== item.label) misroutes.push({ ...item, predicted, reason });
  }
  const total = items.length;
  const correct = confusion.easy.easy + confusion.hard.hard;
  const predictedHard = confusion.easy.hard + confusion.hard.hard;
  const actualHard = confusion.hard.easy + confusion.hard.hard;
  return {
    total,
    accuracy: total ? correct / total : 0,
    // Precision: of the questions sent to the cloud, how many needed it (the
    // cost side). Recall: of the questions that needed it, how many went (the
    // quality side).
    hardPrecision: predictedHard ? confusion.hard.hard / predictedHard : 0,
    hardRecall: actualHard ? confusion.hard.hard / actualHard : 0,
    confusion,
    misroutes,
  };
}

const pct = (value) => `${(value * 100).toFixed(1)}%`;

export function formatDifficulty(name, result) {
  const { confusion: c } = result;
  return [
    `${name}: ${result.total} questions · accuracy ${pct(result.accuracy)} · hard precision ${pct(result.hardPrecision)} · hard recall ${pct(result.hardRecall)}`,
    `  actual \\ predicted   easy   hard`,
    `  easy               ${String(c.easy.easy).padStart(5)}  ${String(c.easy.hard).padStart(5)}`,
    `  hard               ${String(c.hard.easy).padStart(5)}  ${String(c.hard.hard).padStart(5)}`,
    ...result.misroutes.map((m) => `  ${m.label}→${m.predicted}${m.reason ? ` (${m.reason})` : ''}: ${m.query}`),
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(formatDifficulty('held-out', evaluateDifficulty(loadHeldOut())));
  console.log(formatDifficulty('sessions', evaluateDifficulty(loadSessionTurns())));
  console.log(formatDifficulty('adversarial-easy', evaluateDifficulty(loadAdversarialEasy())));
}
