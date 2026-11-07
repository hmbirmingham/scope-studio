// Which tier serves a step.
//
// Ported from the server's routing layer. Two things survive intact and one
// changes.
//
// Survives: the privacy ordering. A private source in context forces local and
// outranks every other input, including an explicit request for cloud. If local
// cannot serve, the step is refused rather than sent anywhere else. Fail
// closed, never reroute.
//
// Survives: the difficulty wording. A local 8B model handles lookups well and
// gets comparisons, causes, code changes and multi-part asks wrong in ways that
// read as right. The rule is deliberately plain words so it can be read and
// tuned rather than trusted.
//
// Changes: what "cloud available" means. There is no API key and there never
// will be — cloud is headless Claude Code on the subscription, under a hard
// ceiling of 20% of a day's Pro usage. Pro meters rolling windows and exposes
// no remaining quota, so the ceiling is a self-imposed allowance in steps. It
// is zero until a week of runs has calibrated it, which means cloud is off by
// construction right now, and the router has to say so rather than quietly
// behaving as if the step were easy.

export const LOCAL = 'local';
export const CLOUD = 'cloud';

const HARD_PATTERNS = [
  // Comparing and judging.
  /\b(compare|comparison|versus|vs\.?|better than|worse than|trade-?offs?|pros and cons|alternatives?|competitors?|competitive|benchmark against)\b/i,
  // Causes and reasons.
  /^\s*(why|how come)\b/i,
  /\b(explain why|root cause|what caused|reason for)\b/i,
  // Changing or building code.
  /\b(refactor|rewrite|implement|redesign|architect|migrate|optimi[sz]e|debug|fix (the|this|a)|add (a|an) (feature|test|endpoint))\b/i,
  // Reviewing and planning.
  /\b(review|audit|evaluate|assess|critique|plan for|design (a|an|the))\b/i,
];

const LONG_QUESTION_WORDS = 35;

/** Null for a question the local model should answer, or why it is hard. */
export function questionDifficulty(query) {
  const text = query.trim();
  if (HARD_PATTERNS.some((pattern) => pattern.test(text))) return 'wording';
  if (text.split(/\s+/).length > LONG_QUESTION_WORDS) return 'length';
  if ((text.match(/\?/g) ?? []).length >= 2) return 'multi_part';
  return null;
}

/**
 * How much cloud this run may spend. Zero means the allowance has not been
 * calibrated, which is not the same as the subscription being absent — the
 * reason is reported so a run never looks like it chose local on merit.
 */
export function cloudAllowance(config, { spentToday = 0 } = {}) {
  const ceiling = config.cloud?.dailyCloudSteps ?? 0;
  if (ceiling === 0) return { available: false, reason: 'uncalibrated', ceiling, remaining: 0 };
  const remaining = Math.max(0, ceiling - spentToday);
  return { available: remaining > 0, reason: remaining > 0 ? null : 'ceiling_reached', ceiling, remaining };
}

function decision(tier, reason, available, blockedCode) {
  return { tier, reason, blocked: available ? null : blockedCode };
}

/**
 * The tier for one step.
 *
 * Order is the contract, not an implementation detail. Privacy first, then an
 * explicit choice, then availability, then difficulty. Anything that reorders
 * these reopens a hole: putting the user's choice above privacy would let
 * `--cloud` carry vault text off the machine.
 *
 * @param {object} args
 * @param {Array<{privacy?: string}>} args.sources what is going into the prompt
 * @param {string|null} args.preferred an explicit tier, if the caller asked
 * @param {boolean} args.localAvailable
 * @param {{available: boolean, reason: string|null}} args.cloud from cloudAllowance
 * @param {string|null} args.hard from questionDifficulty
 */
export function decideRoute({ sources = [], preferred = null, localAvailable, cloud, hard = null }) {
  if (sources.some((source) => source.privacy === 'local')) {
    return decision(LOCAL, 'privacy_flag', localAvailable, 'local_unavailable');
  }
  if (preferred === CLOUD) {
    return decision(CLOUD, 'user_override', cloud.available, cloud.reason ?? 'cloud_unavailable');
  }
  if (preferred === LOCAL) {
    return decision(LOCAL, 'user_override', localAvailable, 'local_unavailable');
  }
  if (!localAvailable) {
    return decision(CLOUD, 'no_ollama', cloud.available, cloud.reason ?? 'cloud_unavailable');
  }
  if (hard && cloud.available) {
    return decision(CLOUD, 'complexity', true, null);
  }
  // Hard wording with no cloud allowance is still served locally — the point of
  // recording `hard` here is that the trace can later say which answers were
  // written by a model the router already judged too small for the question.
  return decision(LOCAL, hard ? `local_only_despite_${hard}` : 'local_sufficient', true, null);
}

/** One line, for the run log and the trace. */
export function describeRoute(route) {
  const blocked = route.blocked ? `, blocked: ${route.blocked}` : '';
  return `${route.tier} (${route.reason}${blocked})`;
}
