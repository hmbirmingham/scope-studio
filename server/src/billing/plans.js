// The product's plans, in one place, so a pricing change is a single edit.
// Opus is deliberately absent: at ~$0.0128 an answer it does not fit a tier
// sold in answers per month (ARCHITECTURE.md § Unit economics of a cloud answer).
//
// Who decides that an answer goes to the cloud is the line between plans.
// Choosing Cloud or Web yourself is Key Pro only, on your own key: a measured
// comparison question cost $0.0425, eight times the estimate the metered plans
// were priced on, and the difference came from choices the user made. On
// Student and Engineer the cloud is reached only through Auto, only when the
// local model cannot answer, and only within the week's allowance — the most
// efficient path, paid by the platform, bounded by the plan.

const WEEKS_PER_MONTH = 30 / 7;

export const CLOUD_MODELS = ['claude-sonnet-5', 'claude-haiku-4-5'];

// Platform-paid answers start on Sonnet and move to Haiku, about half the cost
// per answer, once half the week's allowance is spent, so the allowance lasts
// the week instead of running out midway.
export const PLATFORM_MODELS = { primary: 'claude-sonnet-5', economy: 'claude-haiku-4-5' };
export const ECONOMY_THRESHOLD = 0.5;

export const PLANS = {
  // Local only, unlimited. Nothing leaves the machine and nothing is billed.
  free: { chooseCloud: false, autoCloud: false, ownKey: false, monthlyUsd: 0, cloud: null, effort: null },
  // The user's own key: their spend, their choice, no allowance to enforce.
  key_pro: { chooseCloud: true, autoCloud: true, ownKey: true, monthlyUsd: null, cloud: 'claude-sonnet-5', effort: 'medium' },
  student: { chooseCloud: false, autoCloud: true, ownKey: false, monthlyUsd: 2.25, cloud: 'claude-sonnet-5', effort: 'medium' },
  // Same models, more capacity and more thinking per answer.
  engineer: { chooseCloud: false, autoCloud: true, ownKey: false, monthlyUsd: 6, cloud: 'claude-sonnet-5', effort: 'high' },
};

export function planFor(name) {
  return PLANS[name] ?? PLANS.free;
}

// Picking the Cloud tier or web search by hand.
export function canChooseCloud(name) {
  return planFor(name).chooseCloud === true;
}

// Auto may route to the cloud when the local model cannot answer.
export function canAutoCloud(name) {
  return planFor(name).autoCloud === true;
}

export function weeklyAllowanceUsd(name) {
  const { monthlyUsd } = planFor(name);
  return monthlyUsd === null ? null : monthlyUsd / WEEKS_PER_MONTH;
}

export function platformModel(spentUsd, allowanceUsd) {
  return allowanceUsd > 0 && spentUsd / allowanceUsd >= ECONOMY_THRESHOLD
    ? PLATFORM_MODELS.economy
    : PLATFORM_MODELS.primary;
}

// An override is honoured only if the product actually offers that model.
export function resolveCloudModel(planName, override = process.env.CLOUD_CHAT_MODEL) {
  const fallback = planFor(planName).cloud ?? PLANS.key_pro.cloud;
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
