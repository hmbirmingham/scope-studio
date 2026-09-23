import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isRelevant, judge, nodePath } from '../../src/benchmark/judge.js';
import { ABLATIONS, aggregate, formatTable, parseArgs } from '../../src/benchmark/run.js';

const chunk = (project, path, content = '') => ({ project, external_id: `123|0|${path}`, content });

describe('nodePath', () => {
  test('strips the repo id and chunk index; repository nodes have no path', () => {
    assert.equal(nodePath(chunk('p', 'server/src/db/migrate.js')), 'server/src/db/migrate.js');
    assert.equal(nodePath({ external_id: '123' }), null);
    assert.equal(nodePath({ external_id: null }), null);
  });
});

describe('isRelevant', () => {
  const expectation = { project: 'hmbirmingham/imaging-system', path: 'quantify.py', content: 'def quantify_colonies' };

  test('the right chunk of the right file in the right project', () => {
    assert.equal(isRelevant(chunk('hmbirmingham/imaging-system', 'quantify.py', 'def quantify_colonies(img):'), expectation), true);
  });
  test('same file, wrong chunk, when a content pattern is given', () => {
    assert.equal(isRelevant(chunk('hmbirmingham/imaging-system', 'quantify.py', 'import cv2'), expectation), false);
  });
  test('same path in another project is a different file', () => {
    assert.equal(isRelevant(chunk('hmbirmingham/focus-guard', 'quantify.py', 'def quantify_colonies'), expectation), false);
  });
  test('path matches as a suffix on a directory boundary, not a bare substring', () => {
    const packageJson = { project: 'hmbirmingham/huskybook', path: 'client/package.json' };
    assert.equal(isRelevant(chunk('hmbirmingham/huskybook', 'client/package.json'), packageJson), true);
    assert.equal(isRelevant(chunk('hmbirmingham/huskybook', 'package.json'), packageJson), false);
    assert.equal(isRelevant(chunk('hmbirmingham/huskybook', 'tests/quantify.py'), { project: 'hmbirmingham/huskybook', path: 'quantify.py' }), true);
    assert.equal(isRelevant(chunk('hmbirmingham/huskybook', 'requantify.py'), { project: 'hmbirmingham/huskybook', path: 'quantify.py' }), false);
  });
  test('without a path, any chunk of the project that matches the content counts', () => {
    const flask = { project: 'hmbirmingham/focus-guard', content: 'flask' };
    assert.equal(isRelevant(chunk('hmbirmingham/focus-guard', 'anything/at/all.py', 'from flask import Flask'), flask), true);
    assert.equal(isRelevant(chunk('hmbirmingham/focus-guard', 'app.py', 'import os'), flask), false);
    assert.equal(isRelevant(chunk('hmbirmingham/huskybook', 'app.py', 'from flask import Flask'), flask), false);
  });

  test('content patterns are case-insensitive', () => {
    assert.equal(isRelevant(chunk('p', 'app.py', 'from Flask import Flask'), { project: 'p', path: 'app.py', content: 'flask' }), true);
  });
});

describe('judge', () => {
  const expectations = [
    { project: 'a', path: 'x.py', content: 'def x' },
    { project: 'b', path: 'y.py' },
  ];
  const X = { node: chunk('a', 'x.py', 'def x():') };
  const Y = { node: chunk('b', 'y.py') };
  const noise = { node: chunk('c', 'z.py') };

  test('hit, recall and reciprocal rank come from the pack in rank order', () => {
    const verdict = judge({ selected: [noise, X], candidates: [noise, X, Y], expectations });
    assert.equal(verdict.hit, true);
    assert.equal(verdict.recall, 0.5);
    assert.equal(verdict.mrr, 0.5);
    assert.equal(verdict.candidateHit, true);
    assert.deepEqual(verdict.satisfied.map((s) => [s.packRank, s.candidateRank]), [[2, 2], [null, 3]]);
  });
  test('a relevant node among candidates but not in the pack is a ranking failure, not a retrieval one', () => {
    const verdict = judge({ selected: [noise], candidates: [noise, Y], expectations });
    assert.equal(verdict.hit, false);
    assert.equal(verdict.candidateHit, true);
    assert.equal(verdict.mrr, 0);
  });
  test('nothing relevant anywhere', () => {
    const verdict = judge({ selected: [], candidates: [noise], expectations });
    assert.deepEqual([verdict.hit, verdict.candidateHit, verdict.recall, verdict.mrr], [false, false, 0, 0]);
  });
});

describe('aggregate', () => {
  const row = (category, hit, recall, extra = {}) => ({
    category, hit, candidateHit: hit, recall, mrr: hit ? 1 : 0, expectedTask: 'codebase', inferredTask: 'codebase',
    tokensInjected: 1000, tokensAvailable: 10000, efficiencyRatio: 0.1, retrievalMs: 20, ...extra,
  });
  test('rates overall and per category; null efficiency is skipped, not zeroed', () => {
    const summary = aggregate([
      row('codebase_lookup', true, 1),
      row('codebase_lookup', false, 0, { inferredTask: 'research' }),
      row('cross_project', true, 0.5, { efficiencyRatio: null }),
    ]);
    assert.equal(summary.queries, 3);
    assert.ok(Math.abs(summary.hitRate - 2 / 3) < 1e-9);
    assert.equal(summary.meanRecall, 0.5);
    assert.ok(Math.abs(summary.taskAccuracy - 2 / 3) < 1e-9);
    assert.equal(summary.meanEfficiencyRatio, 0.1);
    assert.equal(summary.byCategory.codebase_lookup.hitRate, 0.5);
    assert.equal(summary.byCategory.cross_project.meanRecall, 0.5);
  });
  test('an empty run produces nulls, not NaN', () => {
    const summary = aggregate([]);
    assert.equal(summary.hitRate, null);
    assert.equal(summary.meanMrr, null);
  });
});

describe('parseArgs', () => {
  test('defaults to the ablation ladder on the local tier', () => {
    const args = parseArgs([]);
    assert.equal(args.tier, 'local_7b');
    assert.deepEqual(Object.keys(args.configs), Object.keys(ABLATIONS));
    assert.equal(args.save, false);
  });
  test('a sweep replaces the ladder with one numeric override per value', () => {
    const args = parseArgs(['--tier', 'cloud_frontier', '--sweep', 'relevance_floor=0.5,0.6', '--save']);
    assert.equal(args.tier, 'cloud_frontier');
    assert.deepEqual(args.configs, { 'relevance_floor=0.5': { relevance_floor: 0.5 }, 'relevance_floor=0.6': { relevance_floor: 0.6 } });
    assert.equal(args.save, true);
  });
  test('--only picks named ablations and rejects unknown ones', () => {
    assert.deepEqual(Object.keys(parseArgs(['--only=v0,full']).configs), ['v0', 'full']);
    assert.throws(() => parseArgs(['--only', 'nope']), /unknown ablation/);
    assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
  });
});

describe('ablation ladder', () => {
  test('each rung adds exactly one component to the one below', () => {
    const rungs = Object.values(ABLATIONS).slice(0, -1).map((c) => Object.values(c.features).filter(Boolean).length);
    assert.deepEqual(rungs, [0, 1, 2, 3]);
    assert.deepEqual(ABLATIONS.full, {});
  });
  test('the table renders one line per run', () => {
    const table = formatTable([{ label: 'full', summary: aggregate([]) }]);
    assert.equal(table.split('\n').length, 2);
  });
});
