import {
  canAutoCloud,
  cloudEffortFor,
  ECONOMY_MAX_TOKENS,
  monthlyAnswerLimit,
  planFor,
  platformEconomy,
  platformModel,
  weeklyAllowanceUsd,
} from './plans.js';

// Whether a plan may have its cloud answers paid for by the platform at all,
// and whether the platform can pay right now. Neither needs the ledger, so the
// route asks this first and a refused request costs no database work. Free has
// no cloud; Key Pro has cloud on its own key, called from the engine, never
// through here.
export function platformCloudRefusal(plan, platformKey = process.env.PLATFORM_ANTHROPIC_API_KEY) {
  if (!canAutoCloud(plan) || !planFor(plan).platformPaid) return 'cloud_not_in_plan';
  // No platform key configured means no platform-paid cloud, never a default.
  if (!platformKey) return 'platform_cloud_unavailable';
  return null;
}

// The key, model, effort and output ceiling a platform answer runs on, or why
// it may not run. This mirrors server/src/billing/credential.js for the
// platform-paid plans, so a Student or Engineer answer is decided the same way
// whichever side makes the call. `modelFor(hard)` is called once the engine
// has said whether the question is hard.
export function resolvePlatformCredential({
  plan,
  weeklySpentUsd = 0,
  monthlyAnswersUsed = 0,
  platformKey = process.env.PLATFORM_ANTHROPIC_API_KEY,
}) {
  const refusal = platformCloudRefusal(plan, platformKey);
  if (refusal) return { blocked: refusal };

  const limit = monthlyAnswerLimit(plan);
  if (limit !== null && monthlyAnswersUsed >= limit) return { blocked: 'answer_limit_reached' };
  const allowance = weeklyAllowanceUsd(plan);
  if (weeklySpentUsd >= allowance) return { blocked: 'allowance_exhausted' };

  // Past half the week's budget: shorter answers (and Opus steps down to Sonnet).
  const economy = platformEconomy(weeklySpentUsd, allowance);
  return {
    blocked: null,
    apiKey: platformKey,
    effort: cloudEffortFor(plan),
    economy,
    ...(economy ? { maxTokens: ECONOMY_MAX_TOKENS, brevity: true } : {}),
    modelFor: (hard) => platformModel(plan, { hard, spentUsd: weeklySpentUsd, allowanceUsd: allowance }),
  };
}
