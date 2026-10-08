import {
  canAutoCloud,
  canChooseCloud,
  cloudEffortFor,
  monthlyAnswerLimit,
  planFor,
  platformEconomy,
  platformModel,
  resolveCloudModel,
  weeklyAllowanceUsd,
} from './plans.js';

const NONE = { apiKey: null, billedTo: null, effort: null, economy: false, modelFor: () => null };

// Which key a cloud answer may use for this request, who pays for it, and how
// its model is picked — or why there is none. Every cloud call goes through
// here, so the plan rules live in one function rather than in the route.
//
// `explicit` is a request that picks the cloud itself: the Cloud tier, or web
// search. Only Key Pro may do that. Auto requests on Student and Engineer may
// reach the cloud on the platform's key while the week's budget lasts.
// `modelFor(hard)` is called once the router knows whether the question is hard.
export function resolveCloudCredential({
  plan,
  headerKey,
  explicit,
  modelChoice,
  weeklySpentUsd = 0,
  monthlyAnswersUsed = 0,
  platformKey = process.env.PLATFORM_ANTHROPIC_API_KEY,
}) {
  if (canChooseCloud(plan)) {
    const model = resolveCloudModel(plan, modelChoice || process.env.CLOUD_CHAT_MODEL);
    return { apiKey: headerKey || null, billedTo: 'user_key', effort: cloudEffortFor(plan), economy: false, blocked: null, modelFor: () => model };
  }
  // Off Key Pro the user's key and model choice are never read.
  if (explicit) return { ...NONE, blocked: 'cloud_requires_key_pro' };
  if (!canAutoCloud(plan) || !planFor(plan).platformPaid) return { ...NONE, blocked: null };

  const limit = monthlyAnswerLimit(plan);
  if (limit !== null && monthlyAnswersUsed >= limit) return { ...NONE, blocked: 'answer_limit_reached' };
  const allowance = weeklyAllowanceUsd(plan);
  if (weeklySpentUsd >= allowance) return { ...NONE, blocked: 'allowance_exhausted' };
  // No platform key configured means no platform-paid cloud, never a default.
  if (!platformKey) return { ...NONE, blocked: null };
  return {
    apiKey: platformKey,
    billedTo: 'platform',
    effort: cloudEffortFor(plan),
    // Past half the week's budget: shorter answers (and Opus → Sonnet).
    economy: platformEconomy(weeklySpentUsd, allowance),
    blocked: null,
    modelFor: (hard) => platformModel(plan, { hard, spentUsd: weeklySpentUsd, allowanceUsd: allowance }),
  };
}
