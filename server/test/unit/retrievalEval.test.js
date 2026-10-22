import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  evaluateDifficulty,
  formatDifficulty,
  loadAdversarialEasy,
  loadHeldOut,
  loadSessionTurns,
} from '../../src/benchmark/difficultyEval.js';
import { assertEvalDatabase, formatReport, loadEvalSet, parseArgs, scoreRanking, summarise } from '../../src/benchmark/retrievalEval.js';

function tempJson(value) {
  const dir = mkdtempSync(join(tmpdir(), 'eval-'));
  const path = join(dir, 'set.json');
  writeFileSync(path, JSON.stringify(value));
  return { path, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('retrieval eval scoring', () => {
  test('recall@k, MRR, coverage and packed recall from a ranking', () => {
    const scored = scoreRanking({ ranked: ['x', 'a', 'y', 'z', 'w', 'q', 'b'], packed: ['x', 'a'], relevant: ['a', 'b'] });
    assert.equal(scored['recall@1'], 0);
    assert.equal(scored['recall@5'], 0.5);
    assert.equal(scored['recall@10'], 1);
    assert.equal(scored.mrr, 0.5, 'first relevant node at rank 2');
    assert.equal(scored.coverage, 1);
    assert.equal(scored.packed, 0.5);
  });

  test('a query whose nodes were never retrieved scores zero everywhere', () => {
    const scored = scoreRanking({ ranked: ['x', 'y'], packed: ['x'], relevant: ['a'] });
    assert.deepEqual(Object.values(scored), [0, 0, 0, 0, 0, 0]);
  });

  test('summarise averages overall and per group, and totals unscored candidates', () => {
    const row = (group, recall, unscored) => ({
      group, 'recall@1': recall, 'recall@5': recall, 'recall@10': recall, mrr: recall, coverage: recall, packed: recall, unscored,
    });
    const summary = summarise([row('kicad', 1, 2), row('kicad', 0, 1), row('cad', 1, 0)]);
    assert.equal(summary.queries, 3);
    assert.equal(summary['recall@5'], 2 / 3);
    assert.equal(summary.unscored, 3);
    assert.equal(summary.byGroup.kicad['recall@5'], 0.5);
    assert.equal(summary.byGroup.cad.queries, 1);
    const report = formatReport({ lexical: { summary, rows: [{ id: 'q1', 'recall@5': 0 }] }, nomic: null });
    assert.match(report, /below full recall@5: q1/);
    assert.match(report, /nomic: not run/);
  });

  test('the shipped eval set covers every vertical node type and is internally consistent', () => {
    const set = loadEvalSet();
    const types = new Set(set.nodes.map((node) => node.type));
    for (const type of ['schematic', 'board', 'symbol', 'net', 'footprint', 'bom_row', 'note', 'excerpt',
      'derivation', 'computation', 'part', 'assembly', 'plan', 'step', 'finding', 'artifact', 'question']) {
      assert.ok(types.has(type), `corpus has a ${type} node`);
    }
    const relationships = new Set(set.edges.map((edge) => edge.type));
    for (const type of ['connects', 'implements', 'cites', 'contains', 'derived_from', 'produces', 'answers']) {
      assert.ok(relationships.has(type), `corpus has a ${type} edge`);
    }
    assert.ok(set.queries.length >= 40);
  });

  test('a set naming an unknown node is refused', () => {
    const nodes = [{ key: 'a', type: 'file', source: 'github', project: 'p', content: 'x' }];
    const badEdge = tempJson({ nodes, edges: [{ from: 'a', to: 'nope', type: 'references' }], queries: [] });
    const badQuery = tempJson({ nodes, edges: [], queries: [{ id: 'q', query: 'x', relevant: ['nope'] }] });
    const duplicate = tempJson({ nodes: [...nodes, ...nodes], edges: [], queries: [] });
    try {
      assert.throws(() => loadEvalSet(badEdge.path), /unknown node/);
      assert.throws(() => loadEvalSet(badQuery.path), /unknown node nope/);
      assert.throws(() => loadEvalSet(duplicate.path), /duplicate/);
    } finally {
      badEdge.done();
      badQuery.done();
      duplicate.done();
    }
  });
});

describe('retrieval eval database guard', () => {
  test('a local database named for tests or evals is accepted', () => {
    assert.equal(assertEvalDatabase('postgres://scope@localhost:5432/scope_test_x'), 'scope_test_x');
    assert.equal(assertEvalDatabase('postgres://scope@127.0.0.1/retrieval_eval'), 'retrieval_eval');
  });

  test('a remote host is refused, even when allowed by name', () => {
    assert.throws(() => assertEvalDatabase('postgres://u@db.example.com/scope_test', { allow: true }), /non-local database host/);
  });

  test('a local database with another name needs --allow-database', () => {
    assert.throws(() => assertEvalDatabase('postgres://scope@localhost/scope'), /--allow-database/);
    assert.equal(assertEvalDatabase('postgres://scope@localhost/scope', { allow: true }), 'scope');
    assert.throws(() => assertEvalDatabase(undefined), /DATABASE_URL/);
  });

  test('--allow-database is a flag that takes no value', () => {
    const args = parseArgs(['--allow-database', '--modes', 'lexical']);
    assert.equal(args.allowDatabase, true);
    assert.deepEqual(args.modes, ['lexical']);
    assert.equal(parseArgs([]).allowDatabase, false);
  });
});

describe('difficulty eval', () => {
  test('builds the confusion matrix, precision and recall from a classifier', () => {
    const items = [
      { query: 'a', label: 'easy' },
      { query: 'b', label: 'easy' },
      { query: 'c', label: 'hard' },
      { query: 'd', label: 'hard' },
      { query: 'e', label: 'hard' },
    ];
    const hard = new Set(['b', 'c', 'd']);
    const result = evaluateDifficulty(items, (q) => (hard.has(q) ? 'wording' : null));
    assert.deepEqual(result.confusion, { easy: { easy: 1, hard: 1 }, hard: { easy: 1, hard: 2 } });
    assert.equal(result.accuracy, 3 / 5);
    assert.equal(result.hardPrecision, 2 / 3);
    assert.equal(result.hardRecall, 2 / 3);
    assert.deepEqual(result.misroutes.map((m) => [m.query, m.predicted]), [['b', 'hard'], ['e', 'easy']]);
    assert.match(formatDifficulty('t', result), /easy→hard \(wording\): b/);
  });

  test('session turns: lookups are easy, hard turns hard, follow-ups left out', () => {
    const turns = loadSessionTurns();
    assert.ok(turns.length > 100);
    assert.ok(turns.every((turn) => turn.label === 'easy' || turn.label === 'hard'));
    assert.ok(!turns.some((turn) => turn.query === 'Summarise the bugs we found today.'), 'a follow-up');
    assert.ok(turns.some((turn) => turn.query === 'What does quantify_colonies return?' && turn.label === 'easy'));
    assert.ok(turns.some((turn) => turn.query.startsWith('Refactor create_poll') && turn.label === 'hard'));
  });

  test('the adversarial-easy set loads apart from the held-out set, all easy', () => {
    const adversarial = loadAdversarialEasy();
    assert.ok(adversarial.length >= 15);
    assert.ok(adversarial.every((item) => item.label === 'easy'));
    const heldOut = new Set(loadHeldOut().map((item) => item.query));
    assert.ok(adversarial.every((item) => !heldOut.has(item.query)), 'no overlap with the held-out set');
  });

  test('the held-out set is labelled and balanced; a bad label is refused', () => {
    const items = loadHeldOut();
    assert.ok(items.filter((i) => i.label === 'easy').length >= 20);
    assert.ok(items.filter((i) => i.label === 'hard').length >= 20);
    const bad = tempJson({ queries: [{ query: 'x', label: 'medium' }] });
    try {
      assert.throws(() => loadHeldOut(bad.path), /bad label medium/);
    } finally {
      bad.done();
    }
  });
});
