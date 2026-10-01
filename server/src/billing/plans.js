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

// Payment fees on every charge, then the share of what is left the platform
// keeps. Lemon Squeezy is the merchant of record — it collects and remits sales
// tax and VAT — and charges 5% + $0.50 a transaction for it.
export const CARD_FEE_RATE = 0.05;
export const CARD_FEE_FIXED_USD = 0.5;
export const MARGIN_TARGET = 0.6;

// Opus is offered for Engineer's hard questions and as Key Pro's opt-in, never
// as anyone's default.
export const CLOUD_MODELS = ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5'];
const MODEL_STEP_DOWN = { 'claude-opus-5': 'claude-sonnet-5', 'claude-sonnet-5': 'claude-haiku-4-5', 'claude-haiku-4-5': 'claude-haiku-4-5' };

// Past half the week's budget every platform model steps down one level, so
// the budget lasts the week instead of running out midway.
export const ECONOMY_THRESHOLD = 0.5;

// What a platform-paid answer costs at full quality, measured live on
// 2026-09-30 (full cloud context; follow-ups read it cached). Trimming the
// context to save money was measured too and rejected: the cloud hit rate fell
// from 95% to 80% at half size and 90% at 3,500 tokens.
export const MEASURED_ANSWER_USD = { 'claude-sonnet-5': 0.02, 'claude-opus-5': 0.055 };
export const MEASURED_HARD_SHARE = 0.2;

// Advertised cloud answers per month. Set so a typical user reaches the count
// before the dollar budget, keeping the margin at or above target; the dollar
// budget is still enforced underneath, so a costly mix stops early rather than
// costing more.

export const PLANS = {
  // Local only, unlimited. Nothing leaves the machine and nothing is billed.
  free: { priceUsd: 0, chooseCloud: false, autoCloud: false, ownKey: false, platformPaid: false, models: null, effort: null },
  // The user's own key: their spend, their choice of model, no budget to enforce.
  key_pro: {
    priceUsd: 5, chooseCloud: true, autoCloud: true, ownKey: true, platformPaid: false,
    models: { default: 'claude-sonnet-5', hard: 'claude-sonnet-5' }, choosable: CLOUD_MODELS, effort: 'medium',
  },
  student: {
    priceUsd: 12, chooseCloud: false, autoCloud: true, ownKey: false, platformPaid: true, monthlyAnswers: 200,
    models: { default: 'claude-sonnet-5', hard: 'claude-sonnet-5' }, effort: 'medium',
  },
  // Opus where it earns its cost: the hard questions.
  engineer: {
    priceUsd: 25, chooseCloud: false, autoCloud: true, ownKey: false, platformPaid: true, monthlyAnswers: 340,
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

// What a month's price leaves after payment fees.
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

export function monthlyAnswerLimit(name) {
  return planFor(name).monthlyAnswers ?? null;
}

// What one platform answer costs on average for this plan's model mix.
export function measuredAnswerUsd(name) {
  const models = planFor(name).models;
  if (!models) return 0;
  const hard = MEASURED_ANSWER_USD[models.hard];
  const easy = MEASURED_ANSWER_USD[models.default];
  return MEASURED_HARD_SHARE * hard + (1 - MEASURED_HARD_SHARE) * easy;
}

export function cloudEffortFor(planName) {
  return planFor(planName).effort ?? 'medium';
}
