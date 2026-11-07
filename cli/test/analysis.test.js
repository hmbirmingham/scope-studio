import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  claimsOf,
  correctionNotes,
  groundQuotes,
  normalizeQuote,
  parseAnalysis,
  uncitedClaims,
  copiedClaims,
} from '../src/eval/analysis.js';
import { runGates } from '../src/eval/check.js';

const sources = `
- Bootstrap samples use ~63% of rows per tree, leaving ~37% untouched
- Random forests extend bagging by also sampling a random subset of columns per tree
- Why √P? Empirically validated, no clean mathematical proof known
`;

const good = `### Out-of-Bag Error
Unused rows serve as a pseudo test set.
> Bootstrap samples use ~63% of rows per tree, leaving ~37% untouched

### Random Forests
Each tree sees a subset of columns.
> Random forests extend bagging by also sampling a random subset of columns per tree
`;

// The exact failure from the live run: a true, well-formed, unsourced clause.
const hallucinated = `### Random Forests
Random forests reduce correlation between trees and improve performance.
> Random forests reduce the correlation between individual trees
`;

test('analysis splits an answer into claims with their citations', () => {
  const claims = claimsOf(parseAnalysis(good));
  assert.equal(claims.length, 2);
  assert.equal(claims[0].heading, 'Out-of-Bag Error');
  assert.equal(claims[0].text, 'Unused rows serve as a pseudo test set.');
  assert.equal(claims[0].quotes.length, 1);
});

test('normalizeQuote only folds the characters models substitute silently', () => {
  assert.equal(normalizeQuote('“Smart” quotes — and  spaces'), '"smart" quotes - and spaces');
  assert.equal(normalizeQuote('≈63%'), '~63%');
});

test('a real quote is grounded and a plausible invented one is not', () => {
  assert.equal(groundQuotes(parseAnalysis(good), sources).ungrounded.length, 0);
  const bad = groundQuotes(parseAnalysis(hallucinated), sources);
  assert.equal(bad.grounded.length, 0);
  assert.equal(bad.ungrounded.length, 1);
  assert.match(bad.ungrounded[0].quote, /reduce the correlation/);
});

test('grounding survives smart quotes and whitespace the model reflows', () => {
  const reflowed = '### A\nclaim\n> Bootstrap samples use ≈63% of rows per tree,   leaving ≈37% untouched\n';
  assert.equal(groundQuotes(parseAnalysis(reflowed), sources).ungrounded.length, 0);
});

test('a claim with no quote is reported as uncited', () => {
  const analysis = parseAnalysis('### A\nAn assertion with nothing behind it.\n');
  assert.equal(uncitedClaims(analysis).length, 1);
});

test('the grounding gate fails the hallucinated output and passes the sourced one', () => {
  const gates = [{ id: 'grounded', check: 'quotes_grounded' }, { id: 'cited', check: 'claims_cited' }];
  assert.equal(runGates(gates, good, { sources }).passed, true);

  const bad = runGates(gates, hallucinated, { sources });
  assert.equal(bad.passed, false);
  assert.match(bad.results[0].detail, /1 of 1 quotes are not in the source/);
});

test('the grounding gate fails closed with no sources and with no quotes', () => {
  const gates = [{ id: 'grounded', check: 'quotes_grounded' }];
  assert.match(runGates(gates, good, {}).results[0].detail, /no source material/);
  assert.match(runGates(gates, '### A\nclaim\n', { sources }).results[0].detail, /no quotes cited at all/);
});

test('correction notes name the specific claim to repair, not the whole answer', () => {
  const notes = correctionNotes(parseAnalysis(hallucinated), sources);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /under "Random Forests"/i);
  assert.match(notes[0], /not in the source material/);
  assert.match(notes[0], /quote the source exactly, or delete the claim/);
});

test('a mixed answer corrects only its failing claim', () => {
  const mixed = `${good}\n### Invented\nSomething unsupported.\n> A line the source never contained\n`;
  const notes = correctionNotes(parseAnalysis(mixed), sources);
  assert.equal(notes.length, 1, 'the two grounded claims are left alone');
  assert.match(notes[0], /under "Invented"/i);
});

test('a quote the model wrapped in quotation marks still grounds', () => {
  // The first live run reported all twelve real quotes as ungrounded for
  // exactly this reason.
  const wrapped = '### A\nclaim about rows\n> "Bootstrap samples use ~63% of rows per tree, leaving ~37% untouched"\n';
  assert.equal(groundQuotes(parseAnalysis(wrapped), sources).ungrounded.length, 0);
});

test('a claim copied from the source is caught, which grounding alone cannot do', () => {
  // The second live run passed every gate by pairing two source lines.
  const gamed = `### Random Forests
Bagging (bootstrapped aggregating): build many trees on different bootstrap samples, then average
> Random forests extend bagging by also sampling a random subset of columns per tree
`;
  const sourcesWithBoth = `${sources}\n- Bagging (bootstrapped aggregating): build many trees on different bootstrap samples, then average\n`;
  const gates = [
    { id: 'grounded', check: 'quotes_grounded' },
    { id: 'not-copied', check: 'claims_not_copied' },
  ];
  const result = runGates(gates, gamed, { sources: sourcesWithBoth });
  assert.equal(result.results[0].ok, true, 'the quote really is in the source');
  assert.equal(result.results[1].ok, false, 'but the claim is a copy, so it fails');
  assert.match(result.results[1].detail, /copied from the source rather than explained/);
});

test('a claim that merely restates its own quote is caught', () => {
  const echo = '### A\nBootstrap samples use ~63% of rows per tree, leaving ~37% untouched\n> Bootstrap samples use ~63% of rows per tree, leaving ~37% untouched\n';
  assert.equal(copiedClaims(parseAnalysis(echo), sources).length, 1);
});

test('a short claim is not flagged as copied on coincidence', () => {
  const short = '### A\nTrees vary.\n> Bootstrap samples use ~63% of rows per tree, leaving ~37% untouched\n';
  assert.equal(copiedClaims(parseAnalysis(short), sources).length, 0);
});

test('correction notes distinguish a copied claim from an ungrounded one', () => {
  const copied = '### A\nBootstrap samples use ~63% of rows per tree, leaving ~37% untouched\n> Bootstrap samples use ~63% of rows per tree, leaving ~37% untouched\n';
  const notes = correctionNotes(parseAnalysis(copied), sources);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /copied from the source instead of explaining it/);
});

test('inner quote marks changed from double to single still ground', () => {
  // Third false positive from the live runs: the model reproduced the sentence
  // word for word but rendered the nested quotes differently.
  const src = '- Explainability is genuinely hard: "why did this get class A?" -> "a majority of trees said so"';
  const out = `### A\nIt is hard to explain a forest's prediction.\n> "Explainability is genuinely hard: 'why did this get class A?' -> 'a majority of trees said so'"\n`;
  assert.equal(groundQuotes(parseAnalysis(out), src).ungrounded.length, 0);
});

test('canonicalising quote marks does not ground an invented sentence', () => {
  const src = '- Explainability is genuinely hard';
  const out = '### A\nA claim here.\n> "Explainability is trivially easy"\n';
  assert.equal(groundQuotes(parseAnalysis(out), src).ungrounded.length, 1);
});

test('stranded spaces from tag stripping do not break grounding', () => {
  // A fetched page reads "( DCG )" and "retrieval . [ 1 ]" because inline tags
  // were replaced with spaces; a person quotes it without them.
  const page = 'Discounted cumulative gain ( DCG ) is a measure of ranking quality in information retrieval . [ 1 ]';
  const out = '### DCG\nIt scores how well a ranking is ordered.\n> Discounted cumulative gain (DCG) is a measure of ranking quality in information retrieval.\n';
  assert.equal(groundQuotes(parseAnalysis(out), page).ungrounded.length, 0);
});

test('normalising spacing does not excuse a genuine misquote', () => {
  // The live run fused two neighbouring sentences: the source says the base
  // "affects" the value, the model wrote "does affect".
  const page = 'Clearly, the base of the log affects the value of DCG in both formulations.';
  const out = '### Log base\nThe base matters.\n> The base of the log does affect the value of DCG in both formulations.\n';
  assert.equal(groundQuotes(parseAnalysis(out), page).ungrounded.length, 1);
});

test('min_claims catches a brief that passed by saying almost nothing', () => {
  // A live brief passed every other gate with two claims: the cheapest way to
  // satisfy "every claim must be grounded" is to make very few claims.
  const thin = `### One finding
A single point, properly sourced and long enough to clear any word minimum easily.
> Bootstrap samples use ~63% of rows per tree, leaving ~37% untouched
`;
  const { passed, results } = runGates([{ id: 'enough', check: 'min_claims', arg: 4 }], thin, { sources });
  assert.equal(passed, false);
  assert.match(results[0].detail, /1 claims, minimum 4/);
});

test('a fenced block is not a claim, and neither are its backticks', () => {
  // Live failure: a model wrapped a formula in a fence, each ``` became a
  // claim, and the corrector told the next attempt that "```" needed a quote.
  const analysis = parseAnalysis(
    ['### Gain', 'Relevance is discounted by position.', '> position discount', '', '```', 'DCG = sum rel_i / log2(i+1)', '```'].join('\n')
  );
  const claims = claimsOf(analysis);
  assert.deepEqual(
    claims.map((c) => c.text),
    ['Relevance is discounted by position.']
  );
});

test('a horizontal rule separates claims rather than becoming one', () => {
  const analysis = parseAnalysis(['first claim here', '', '---', '', 'second claim here'].join('\n'));
  assert.deepEqual(
    claimsOf(analysis).map((c) => c.text),
    ['first claim here', 'second claim here']
  );
});
