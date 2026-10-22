import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PROJECT_BOOST,
  SUPERSEDE_DEMOTION,
  TASK_TYPE_BOOST,
  boostMultiplier,
  DEFINITION_BOOST,
  definitionMatch,
  fuseAndScore,
  recencyBoost,
  resolveConfig,
} from '../../src/retrieval/score.js';

const NOW = new Date('2026-09-22T12:00:00Z');
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function node(overrides = {}) {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    type: 'file',
    project: 'p',
    source: 'github',
    created_at: hoursAgo(0),
    last_confirmed_useful: null,
    superseded: false,
    ...overrides,
  };
}

describe('resolveConfig', () => {
  test('unknown tier throws', () => {
    assert.throws(() => resolveConfig('gpu_cluster'), /unknown tier/);
  });

  test('tier params apply and features default on', () => {
    const local = resolveConfig('local_7b');
    const cloud = resolveConfig('cloud_frontier');
    assert.equal(local.max_nodes, 5);
    assert.equal(cloud.max_nodes, 10);
    assert.ok(local.relevance_floor > cloud.relevance_floor, 'local tier is stricter');
    assert.deepEqual(Object.values(local.features).every(Boolean), true);
  });

  test('overrides merge params and individual features', () => {
    const config = resolveConfig('local_7b', { max_nodes: 3, features: { expansion: false } });
    assert.equal(config.max_nodes, 3);
    assert.equal(config.features.expansion, false);
    assert.equal(config.features.recency_decay, true);
  });
});

describe('recencyBoost', () => {
  test('fresh node is ~1, 200h-old decision is ~0', () => {
    assert.ok(recencyBoost(node({ type: 'decision' }), NOW) > 0.99);
    const aged = recencyBoost(node({ type: 'decision', created_at: hoursAgo(200) }), NOW);
    assert.ok(aged < 0.01 && aged > 0, `expected ~0.0025, got ${aged}`);
  });

  test('confirmation re-anchors recency', () => {
    const aged = node({ type: 'decision', created_at: hoursAgo(200), last_confirmed_useful: hoursAgo(0) });
    assert.ok(recencyBoost(aged, NOW) > 0.99);
  });

  test('slow-aging types decay slower than fast-aging ones', () => {
    const repo = recencyBoost(node({ type: 'repo', created_at: hoursAgo(48) }), NOW);
    const conversation = recencyBoost(node({ type: 'conversation', created_at: hoursAgo(48) }), NOW);
    assert.ok(repo > conversation);
  });
});

describe('recency across every node type', () => {
  // Every type the nodes_type_check constraint accepts (migrations 020, 039).
  const TYPES = ['repo', 'file', 'decision', 'spec', 'paper', 'datasheet', 'conversation',
    'plan', 'step', 'finding', 'artifact', 'question',
    'schematic', 'board', 'symbol', 'net', 'footprint', 'bom_row', 'note', 'excerpt',
    'derivation', 'computation', 'part', 'assembly'];

  test('every node type decays to a finite score, so it can be ranked', () => {
    for (const type of TYPES) {
      const boost = recencyBoost(node({ type, created_at: hoursAgo(10) }), NOW);
      assert.ok(Number.isFinite(boost) && boost > 0 && boost < 1, type);
    }
  });

  test('a type the table has never heard of ages like a file instead of scoring NaN', () => {
    assert.equal(recencyBoost(node({ type: 'hologram', created_at: hoursAgo(10) }), NOW),
      recencyBoost(node({ type: 'file', created_at: hoursAgo(10) }), NOW));
  });

  test('vertical nodes take their place in the fused ranking', () => {
    const config = resolveConfig('local_7b');
    const lexical = [node({ id: 'net', type: 'net' }), node({ id: 'file', type: 'file' }), node({ id: 'part', type: 'part' })]
      .map((n) => ({ node: n }));
    const scored = fuseAndScore({ dense: [], lexical, now: NOW, config });
    assert.deepEqual(scored.map((entry) => entry.node.id), ['net', 'file', 'part']);
    assert.ok(scored.every((entry) => Number.isFinite(entry.score)));
  });
});

describe('fuseAndScore', () => {
  const config = resolveConfig('cloud_frontier');
  const base = { project: null, task: null, now: NOW, config };

  test('a node in both dense and lexical lists outranks a stronger dense-only node', () => {
    const a = node({ id: 'a' });
    const b = node({ id: 'b' });
    const scored = fuseAndScore({
      ...base,
      dense: [{ node: a, similarity: 0.9 }, { node: b, similarity: 0.85 }],
      lexical: [{ node: b, rank: 0.2 }],
    });
    assert.deepEqual(scored.map((entry) => entry.node.id), ['b', 'a']);
    assert.equal(scored[0].lexicalRank, 1);
  });

  test('relevance floor drops low-similarity nodes unless they are lexical hits', () => {
    const low = node({ id: 'low' });
    const lowLexical = node({ id: 'lowLexical' });
    const scored = fuseAndScore({
      ...base,
      dense: [{ node: low, similarity: 0.3 }, { node: lowLexical, similarity: 0.3 }],
      lexical: [{ node: lowLexical, rank: 0.1 }],
    });
    assert.deepEqual(scored.map((entry) => entry.node.id), ['lowLexical']);
  });

  test('active-project boost re-ranks equally relevant nodes', () => {
    const other = node({ id: 'other', project: 'elsewhere' });
    const mine = node({ id: 'mine', project: 'active' });
    const scored = fuseAndScore({
      ...base,
      project: 'active',
      dense: [{ node: other, similarity: 0.8 }, { node: mine, similarity: 0.79 }],
      lexical: [],
    });
    assert.equal(scored[0].node.id, 'mine');
    assert.equal(scored[0].boosts.project, PROJECT_BOOST);
  });

  test('supersede demotion multiplies by 0.1 and can be ablated', () => {
    const current = node({ id: 'current', type: 'decision' });
    const stale = node({ id: 'stale', type: 'decision', superseded: true });
    const dense = [{ node: stale, similarity: 0.9 }, { node: current, similarity: 0.9 }];

    const on = fuseAndScore({ ...base, dense, lexical: [] });
    const staleOn = on.find((entry) => entry.node.id === 'stale');
    assert.equal(staleOn.boosts.demotion, SUPERSEDE_DEMOTION);
    assert.equal(on[0].node.id, 'current');

    const off = fuseAndScore({
      ...base,
      dense,
      lexical: [],
      config: resolveConfig('cloud_frontier', { features: { supersede_demotion: false } }),
    });
    const staleOff = off.find((entry) => entry.node.id === 'stale');
    assert.ok(Math.abs(staleOff.score / staleOn.score - 10) < 1e-6);
  });
});

describe('definitionMatch', () => {
  const chunk = (path, content = '') => ({ type: 'file', external_id: `1|0|${path}`, content });

  test('a definition matches when the query supplied every part of its identifier', () => {
    assert.equal(definitionMatch(chunk('a.py', 'def quantify_colonies(img):'), ['quantify', 'colonies', 'return']), 'quantify_colonies');
    assert.equal(definitionMatch(chunk('a.py', 'class AnomalyDetector:'), ['anomaly', 'detector']), 'AnomalyDetector');
    assert.equal(definitionMatch(chunk('a.js', 'export function fitView() {'), ['fit', 'view']), 'fitView');
    assert.equal(definitionMatch(chunk('a.c', 'static void USART2_Init(void)\n{'), ['usart2', 'init']), 'USART2_Init');
  });

  test('usages, partial names, and unrelated definitions do not match', () => {
    assert.equal(definitionMatch(chunk('t.py', 'result = quantify_colonies(img)'), ['quantify', 'colonies']), null);
    assert.equal(definitionMatch(chunk('a.py', 'def quantify_colonies(img):'), ['quantify']), null);
    assert.equal(definitionMatch(chunk('a.py', 'def health():'), ['flask', 'repositories']), null);
    assert.equal(definitionMatch(chunk('a.py', 'def health():'), []), null);
  });
});

describe('boostMultiplier', () => {
  const features = resolveConfig('cloud_frontier').features;

  test('a definition of the asked-about identifier adds the definition weight; the switch, weight and task gate are honoured', () => {
    const chunk = node({ type: 'file', external_id: '1|0|quantify.py', content: 'def quantify_colonies(img):' });
    const terms = ['quantify', 'colonies'];
    const on = boostMultiplier(chunk, { project: null, task: null, now: NOW, features, terms });
    const codebase = boostMultiplier(chunk, { project: null, task: { task: 'codebase', confidence: 0.6 }, now: NOW, features, terms });
    const research = boostMultiplier(chunk, { project: null, task: { task: 'research', confidence: 0.9 }, now: NOW, features, terms });
    assert.equal(codebase.applied.definition, DEFINITION_BOOST);
    assert.equal(research.applied.definition, 0, 'a research question is not answered by the code that defines its terms');
    const off = boostMultiplier(chunk, { project: null, task: null, now: NOW, features: { ...features, definition_boost: false }, terms });
    const weighted = boostMultiplier(chunk, { project: null, task: null, now: NOW, features, terms, weights: { definition_boost: 0.25 } });
    assert.equal(on.applied.definition, DEFINITION_BOOST);
    assert.equal(off.applied.definition, 0);
    assert.equal(weighted.applied.definition, 0.25);
    assert.ok(Math.abs(on.multiplier - off.multiplier - DEFINITION_BOOST) < 1e-9);
  });

  test('task boost applies only to node types mapped to the inferred task, scaled by confidence', () => {
    const task = { task: 'research', confidence: 0.8 };
    const decision = boostMultiplier(node({ type: 'decision' }), { project: null, task, now: NOW, features });
    const repo = boostMultiplier(node({ type: 'repo' }), { project: null, task, now: NOW, features });
    assert.ok(Math.abs(decision.applied.task - TASK_TYPE_BOOST * 0.8) < 1e-9);
    assert.equal(repo.applied.task, 0);
  });

  test('source boost rewards kicad for hardware and zotero/overleaf for research', () => {
    const kicad = boostMultiplier(node({ source: 'kicad', type: 'datasheet' }), {
      project: null, task: { task: 'hardware', confidence: 0.7 }, now: NOW, features,
    });
    const zotero = boostMultiplier(node({ source: 'zotero', type: 'paper' }), {
      project: null, task: { task: 'research', confidence: 0.7 }, now: NOW, features,
    });
    const mismatch = boostMultiplier(node({ source: 'kicad', type: 'datasheet' }), {
      project: null, task: { task: 'research', confidence: 0.7 }, now: NOW, features,
    });
    assert.equal(kicad.applied.source, 0.2);
    assert.equal(zotero.applied.source, 0.1);
    assert.equal(mismatch.applied.source, 0);
  });
});

