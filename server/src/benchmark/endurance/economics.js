import { createHash } from 'node:crypto';
import { costUsd, priceFor } from '../../lib/anthropic.js';

// The arithmetic behind the endurance verdict, kept free of I/O so every
// threshold can be tested at its boundary.
//
// The question the benchmark answers is whether a working session in Scope
// lasts longer than the same session in a cloud app on the same money. "The
// same money" is the plan's weekly allowance: what the platform will spend on
// one user's cloud answers in a week. Each arm is run over the same turns, and
// the number of turns it could afford on that allowance is the headline.

// Hynes' gate: at least three times the turns of the baseline on equal
// dollars, at a mean quality no lower than 90% of the baseline's.
export const PASS_TURNS_RATIO = 3;
export const PASS_QUALITY_RATIO = 0.9;

// The most a live run may spend, across every arm and scenario in it. It is a
// ceiling, not a default to raise: --max-usd can lower it and never lift it.
export const LIVE_MAX_USD = 5;

// Ratios like 0.27 / 0.3 land a hair either side of 0.9 in floating point; a
// result exactly on the gate has to read as exactly on the gate.
const EPSILON = 1e-9;

export const DRY = 'n/a (dry)';

// The corpus measures nodes the same way (token_length is CEIL(LENGTH / 4) at
// ingestion), so a prompt counted here and the context packed into it agree.
export function estimateTokens(text) {
  return Math.ceil((text?.length ?? 0) / 4);
}

// How many turns an arm could pay for on `budgetUsd`, from its per-turn costs
// in order. When the scenario spends past the budget, that is measured: the
// turns whose running total stayed inside it. When it ends first, the rest is
// projected from the mean cost per turn. Projection flatters a baseline that
// re-sends a growing transcript (its later turns cost more than its mean), so
// a projected ratio understates Scope's lead rather than inflating it.
export function turnsUntilBudget(costs, budgetUsd) {
  if (costs.length === 0) return { turns: null, projected: false, unbounded: false };
  let cumulative = 0;
  for (const [index, cost] of costs.entries()) {
    cumulative += cost;
    if (cumulative > budgetUsd + EPSILON) return { turns: index, projected: false, unbounded: false };
  }
  const mean = cumulative / costs.length;
  // Every turn answered on the local model costs nothing: the budget never runs out.
  if (mean <= 0) return { turns: Infinity, projected: true, unbounded: true };
  return { turns: Math.floor(budgetUsd / mean + EPSILON), projected: true, unbounded: false };
}

// Scope's turns over a baseline's. Null when either side is unknown or when
// neither spent anything, since then there is nothing to compare.
export function turnsRatio(scopeTurns, baselineTurns) {
  if (scopeTurns == null || baselineTurns == null) return null;
  if (scopeTurns === Infinity && baselineTurns === Infinity) return null;
  if (scopeTurns === Infinity) return Infinity;
  if (baselineTurns === 0) return scopeTurns > 0 ? Infinity : null;
  return scopeTurns / baselineTurns;
}

// Mean quality of Scope over the baseline's, on the turns both answered, so an
// arm stopped early by the spend cap is not compared on turns it never saw.
export function qualityRatio(scopeQualities, baselineQualities) {
  const pairs = scopeQualities
    .map((scope, i) => [scope, baselineQualities[i]])
    .filter(([scope, baseline]) => typeof scope === 'number' && typeof baseline === 'number');
  if (pairs.length === 0) return null;
  const scope = pairs.reduce((sum, [value]) => sum + value, 0) / pairs.length;
  const baseline = pairs.reduce((sum, [, value]) => sum + value, 0) / pairs.length;
  if (baseline === 0) return scope === 0 ? 1 : Infinity;
  return scope / baseline;
}

// A dry run has no real answers, so it can say whether the turns gate holds
// but never whether the session passed.
export function verdict({ turnsRatio: turns, qualityRatio: quality, dry = false }) {
  const turnsGate = turns == null ? 'unknown' : turns + EPSILON >= PASS_TURNS_RATIO ? 'pass' : 'fail';
  if (dry) return { verdict: DRY, turnsGate, qualityGate: DRY };
  const qualityGate = quality == null ? 'unknown' : quality + EPSILON >= PASS_QUALITY_RATIO ? 'pass' : 'fail';
  if (turnsGate === 'unknown' || qualityGate === 'unknown') return { verdict: 'incomplete', turnsGate, qualityGate };
  return { verdict: turnsGate === 'pass' && qualityGate === 'pass' ? 'pass' : 'fail', turnsGate, qualityGate };
}

// The run's hard spending ceiling, shared by every arm. A call is refused
// before it is sent when its worst case could cross the ceiling, so the cap is
// never overshot by the call that reaches it; once spend reaches the ceiling,
// every arm stops and the report is marked partial.
export class SpendCap {
  constructor(maxUsd) {
    this.maxUsd = maxUsd;
    this.spentUsd = 0;
    this.stopped = null;
  }

  allows(worstCaseUsd) {
    if (this.stopped) return false;
    if (this.spentUsd + worstCaseUsd > this.maxUsd + EPSILON) {
      this.stopped = { reason: 'next_call_could_cross_cap', spentUsd: this.spentUsd, maxUsd: this.maxUsd };
      return false;
    }
    return true;
  }

  settle(usd) {
    this.spentUsd += usd ?? 0;
    if (!this.stopped && this.spentUsd + EPSILON >= this.maxUsd) {
      this.stopped = { reason: 'cap_reached', spentUsd: this.spentUsd, maxUsd: this.maxUsd };
    }
  }
}

// Code tokenizes denser than four characters a token, so the worst case pads
// the estimate rather than trusting it with the last dollar.
const WORST_CASE_INPUT_FACTOR = 1.5;
const CACHE_WRITE_MULTIPLIER = 1.25;

// The most one request could cost: every input token written to the cache at
// the write premium, and the answer running to max_tokens.
export function worstCaseUsd(model, inputTokens, maxTokens) {
  const price = priceFor(model);
  if (!price) return Infinity;
  return (
    (inputTokens * WORST_CASE_INPUT_FACTOR * price.input * CACHE_WRITE_MULTIPLIER + maxTokens * price.output) /
    1_000_000
  );
}

// The prompt as the cache sees it: the system prompt, then every content
// block in order, each marked where a cache_control breakpoint ends it.
export function promptBlocks({ system, messages }) {
  const blocks = [];
  if (system) {
    const parts = typeof system === 'string' ? [{ text: system }] : system;
    for (const part of parts) blocks.push({ text: part.text ?? '', breakpoint: Boolean(part.cache_control) });
  }
  for (const message of messages) {
    if (typeof message.content === 'string') {
      blocks.push({ text: message.content, breakpoint: false });
      continue;
    }
    for (const part of message.content) blocks.push({ text: part.text ?? '', breakpoint: Boolean(part.cache_control) });
  }
  return blocks;
}

export function promptTokens(payload) {
  return promptBlocks(payload).reduce((total, block) => total + estimateTokens(block.text), 0);
}

// Prices a request the way the Messages API bills it, for dry runs where no
// real usage comes back. The longest prefix ending at a breakpoint that an
// earlier request already wrote is read at the cache rate, everything from
// there to the last breakpoint is written at the write premium, and whatever
// follows the last breakpoint is fresh input. `cache` is the set of prefixes
// written so far in this arm, keyed by model, since caches are per model.
//
// Every turn is assumed to land inside the cache's lifetime. Real working days
// have pauses longer than five minutes, so this is generous to whichever arm
// leans on the cache most, which is the baseline.
export function priceRequest({ model, system, messages, outputTokens, cache }) {
  const hash = createHash('sha256').update(model);
  const breakpoints = [];
  let total = 0;
  for (const block of promptBlocks({ system, messages })) {
    hash.update(block.text);
    total += estimateTokens(block.text);
    if (block.breakpoint) breakpoints.push({ tokens: total, key: hash.copy().digest('hex') });
  }

  let read = 0;
  for (const point of breakpoints) if (cache.has(point.key)) read = point.tokens;
  const lastBreakpoint = breakpoints.at(-1)?.tokens ?? 0;
  const written = Math.max(0, lastBreakpoint - read);
  for (const point of breakpoints) cache.add(point.key);

  const usage = {
    input_tokens: total - Math.max(read, lastBreakpoint),
    cache_creation_input_tokens: written,
    cache_read_input_tokens: read,
    output_tokens: outputTokens,
  };
  return { usage, costUsd: costUsd(model, usage) ?? 0 };
}

export function mean(values) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}
