// Run budgets: tokens, dollars, wall clock and a step count. The agent sets
// them; a run may tighten any of them (a quick check with a smaller limit) but
// never loosen one: the agent's budget is the user's ceiling, and whoever can
// start a run (a task, a schedule) must not be able to lift it. A run stops at
// the first limit it reaches.

// Without a step limit a confused model could loop until another limit hit,
// so every run has one even when the user set none.
export const DEFAULT_MAX_STEPS = 50;

const LIMITS = ['maxTokens', 'maxUsd', 'maxWallMs', 'maxSteps'];

function positive(value) {
  const number = Number(value);
  return value != null && Number.isFinite(number) && number > 0 ? number : null;
}

// Each limit is the smaller of the agent's and the run's; a limit only one
// of them sets is that one. The default step limit counts as the agent's, so
// a run cannot raise it either.
export function effectiveBudget(agentBudget = {}, runBudget = {}) {
  const budget = {};
  for (const limit of LIMITS) {
    const ceiling = positive(agentBudget?.[limit]) ?? (limit === 'maxSteps' ? DEFAULT_MAX_STEPS : null);
    const requested = positive(runBudget?.[limit]);
    budget[limit] = ceiling == null ? requested : requested == null ? ceiling : Math.min(ceiling, requested);
  }
  return budget;
}

// Validates a per-run override from a request body; null when it is fine.
export function budgetError(budget) {
  if (budget == null) return null;
  if (typeof budget !== 'object' || Array.isArray(budget)) return 'budget must be an object';
  for (const [key, value] of Object.entries(budget)) {
    if (!LIMITS.includes(key)) return `budget.${key} is not a budget limit`;
    if (value !== null && positive(value) === null) return `budget.${key} must be a positive number`;
  }
  return null;
}

// Which limit, if any, the run has reached. `steps` counts executed steps
// (the plan is one), so maxSteps: 3 allows the plan and two actions.
export function exceededLimit(budget, { tokens = 0, usd = 0, wallMs = 0, steps = 0 }) {
  if (budget.maxTokens != null && tokens >= budget.maxTokens) return 'tokens';
  if (budget.maxUsd != null && usd >= budget.maxUsd) return 'usd';
  if (budget.maxWallMs != null && wallMs >= budget.maxWallMs) return 'wall';
  if (budget.maxSteps != null && steps >= budget.maxSteps) return 'steps';
  return null;
}

// Milliseconds of wall clock left, or null when the run has no wall limit.
export function wallRemaining(budget, wallMs) {
  return budget.maxWallMs == null ? null : Math.max(0, budget.maxWallMs - wallMs);
}
