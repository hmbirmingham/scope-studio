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
} from '../../billing/plans.js';

const NONE = { apiKey: null, billedTo: null, effort: null, economy: false, modelFor: () => null };

// The benchmark plays a whole week of platform-paid answers on its own, so it
// needs the control plane's rules (control/src/billing/credential.js) without
// a control plane: which key an answer may use, the model, and when economy
// mode and the allowance cut-over happen, against the arm's own running spend.
// The engine itself no longer decides any of this for platform answers; it
// asks the control plane. Only the benchmark's live mode ever sends a real
// key, and only one passed in explicitly: there is no environment default.
export function simulatePlatformCredential({
  plan,
  headerKey,
  explicit,
  modelChoice,
  weeklySpentUsd = 0,
  monthlyAnswersUsed = 0,
  platformKey,
}) {
  if (canChooseCloud(plan)) {
    const model = resolveCloudModel(plan, modelChoice || process.env.CLOUD_CHAT_MODEL);
    return { apiKey: headerKey || null, billedTo: 'user_key', effort: cloudEffortFor(plan), economy: false, blocked: null, modelFor: () => model };
  }
  if (explicit) return { ...NONE, blocked: 'cloud_requires_key_pro' };
  if (!canAutoCloud(plan) || !planFor(plan).platformPaid) return { ...NONE, blocked: null };

  const limit = monthlyAnswerLimit(plan);
  if (limit !== null && monthlyAnswersUsed >= limit) return { ...NONE, blocked: 'answer_limit_reached' };
  const allowance = weeklyAllowanceUsd(plan);
  if (weeklySpentUsd >= allowance) return { ...NONE, blocked: 'allowance_exhausted' };
  if (!platformKey) return { ...NONE, blocked: null };
  return {
    apiKey: platformKey,
    billedTo: 'platform',
    effort: cloudEffortFor(plan),
    economy: platformEconomy(weeklySpentUsd, allowance),
    blocked: null,
    modelFor: (hard) => platformModel(plan, { hard, spentUsd: weeklySpentUsd, allowanceUsd: allowance }),
  };
}
