// The product's plans, in one place, so a pricing change is a single edit.
//
// Who decides that an answer goes to the cloud, and on which model, is the
// line between plans. Choosing Cloud or Web yourself is Key Pro only, on your
// own key. Student and Engineer reach the cloud through Auto: when the local
// model cannot answer, or when the question is one a local 8B model gets wrong
// (see routing/difficulty.js). Those answers are paid by the platform out of a
// budget derived from the plan's price at a fixed margin, so a price change
// moves the budget with it.

const WEEKS_PER_MONTH = 30 / 7;

// Card fees on every charge, then the share of what is left the platform keeps.
export const CARD_FEE_RATE = 0.029;
export const CARD_FEE_FIXED_USD = 0.3;
export const MARGIN_TARGET = 0.6;

// Opus is offered for Engineer's hard questions and as Key Pro's opt-in, never
// as anyone's default.
export const CLOUD_MODELS = ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5'];
const MODEL_STEP_DOWN = { 'claude-opus-5': 'claude-sonnet-5', 'claude-sonnet-5': 'claude-haiku-4-5', 'claude-haiku-4-5': 'claude-haiku-4-5' };

// Past half the week's budget every platform model steps down one level, so
// the budget lasts the week instead of running out midway.
export const ECONOMY_THRESHOLD = 0.5;

export const PLANS = {
  // Local only, unlimited. Nothing leaves the machine and nothing is billed.
  free: { priceUsd: 0, chooseCloud: false, autoCloud: false, ownKey: false, platformPaid: false, models: null, effort: null },
  // The user's own key: their spend, their choice of model, no budget to enforce.
  key_pro: {
    priceUsd: 5, chooseCloud: true, autoCloud: true, ownKey: true, platformPaid: false,
    models: { default: 'claude-sonnet-5', hard: 'claude-sonnet-5' }, choosable: CLOUD_MODELS, effort: 'medium',
  },
  student: {
    priceUsd: 12, chooseCloud: false, autoCloud: true, ownKey: false, platformPaid: true,
    models: { default: 'claude-sonnet-5', hard: 'claude-sonnet-5' }, effort: 'medium',
  },
  // Opus where it earns its cost: the hard questions.
  engineer: {
    priceUsd: 25, chooseCloud: false, autoCloud: true, ownKey: false, platformPaid: true,
    models: { default: 'claude-sonnet-5', hard: 'claude-opus-5' }, effort: 'medium',
  },
};

export function planFor(name) {
  return PLANS[name] ?? PLANS.free;
}

export function canChooseCloud(name) {
  return planFor(name).chooseCloud === true;
}

export function canAutoCloud(name) {
  return planFor(name).autoCloud === true;
}

// What a month's price leaves after card fees.
export function netRevenueUsd(name) {
  const { priceUsd } = planFor(name);
  return priceUsd > 0 ? priceUsd * (1 - CARD_FEE_RATE) - CARD_FEE_FIXED_USD : 0;
}

// The platform-paid cloud budget: what is left of the price once the margin is
// kept. Null on Key Pro (the user's key), zero on Free.
export function monthlyCloudBudgetUsd(name) {
  const plan = planFor(name);
  if (plan.ownKey) return null;
  if (!plan.platformPaid) return 0;
  return netRevenueUsd(name) * (1 - MARGIN_TARGET);
}

export function weeklyAllowanceUsd(name) {
  const monthly = monthlyCloudBudgetUsd(name);
  return monthly === null ? null : monthly / WEEKS_PER_MONTH;
}

// The model a platform-paid answer uses: the plan's model for this kind of
// question, one level cheaper once half the week's budget is spent.
export function platformModel(name, { hard = false, spentUsd = 0, allowanceUsd = weeklyAllowanceUsd(name) } = {}) {
  const models = planFor(name).models;
  if (!models) return null;
  const chosen = hard ? models.hard : models.default;
  return allowanceUsd > 0 && spentUsd / allowanceUsd >= ECONOMY_THRESHOLD ? MODEL_STEP_DOWN[chosen] : chosen;
}

// Key Pro's own choice, or its default. Anything the product does not offer is
// refused, including through CLOUD_CHAT_MODEL.
export function resolveCloudModel(planName, choice = process.env.CLOUD_CHAT_MODEL) {
  const plan = planFor(planName);
  const fallback = plan.models?.default ?? PLANS.key_pro.models.default;
  if (!choice) return fallback;
  if (!CLOUD_MODELS.includes(choice)) {
    throw new Error(`${choice} is not offered. Choose one of: ${CLOUD_MODELS.join(', ')}.`);
  }
  return choice;
}

export function cloudEffortFor(planName) {
  return planFor(planName).effort ?? 'medium';
}
