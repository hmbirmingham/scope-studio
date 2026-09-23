// The product's plans, in one place, so a pricing change is a single edit.
// Opus is deliberately absent: at ~$0.0128 an answer it does not fit a tier
// sold in answers per month (ARCHITECTURE.md § Unit economics of a cloud answer).

const WEEKS_PER_MONTH = 30 / 7;

export const CLOUD_MODELS = ['claude-sonnet-5', 'claude-haiku-4-5'];

export const PLANS = {
  // Local only, unlimited. Nothing leaves the machine and nothing is billed.
  free: { cloud: null, monthlyUsd: 0, ownKey: false, effort: null },
  // The user's own key: their spend, so there is no allowance to enforce.
  key_pro: { cloud: 'claude-sonnet-5', monthlyUsd: null, ownKey: true, effort: 'medium' },
  student: { cloud: 'claude-sonnet-5', monthlyUsd: 2.25, ownKey: false, effort: 'medium' },
  // Same model, more capacity and more thinking per answer — the premium is
  // depth and volume, not a pricier model.
  engineer: { cloud: 'claude-sonnet-5', monthlyUsd: 6, ownKey: false, effort: 'high' },
};

export function planFor(name) {
  return PLANS[name] ?? PLANS.free;
}

export function weeklyAllowanceUsd(name) {
  const { monthlyUsd } = planFor(name);
  return monthlyUsd === null ? null : monthlyUsd / WEEKS_PER_MONTH;
}

// An override is honoured only if the product actually offers that model.
export function resolveCloudModel(planName, override = process.env.CLOUD_CHAT_MODEL) {
  const fallback = planFor(planName).cloud ?? PLANS.student.cloud;
  if (!override) return fallback;
  if (!CLOUD_MODELS.includes(override)) {
    throw new Error(
      `CLOUD_CHAT_MODEL=${override} is not offered. Choose one of: ${CLOUD_MODELS.join(', ')}.`
    );
  }
  return override;
}

export function cloudEffortFor(planName) {
  return planFor(planName).effort ?? 'medium';
}
