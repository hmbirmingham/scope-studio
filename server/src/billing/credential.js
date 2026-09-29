import {
  canAutoCloud,
  canChooseCloud,
  cloudEffortFor,
  platformModel,
  resolveCloudModel,
  weeklyAllowanceUsd,
} from './plans.js';

// Which key a cloud answer may use for this request, who pays for it, and on
// which model — or why there is none. Every cloud call goes through here, so
// the plan rules live in one function rather than in the route's branches.
//
// `explicit` is a request that picks the cloud itself: the Cloud tier, or web
// search. Only Key Pro may do that. Auto requests on Student and Engineer may
// reach the cloud on the platform's key while the week's allowance lasts; the
// router still sends them there only when the local model cannot answer.
export function resolveCloudCredential({
  plan,
  headerKey,
  explicit,
  weeklySpentUsd = 0,
  platformKey = process.env.PLATFORM_ANTHROPIC_API_KEY,
}) {
  if (canChooseCloud(plan)) {
    return {
      apiKey: headerKey || null,
      billedTo: 'user_key',
      model: resolveCloudModel(plan),
      effort: cloudEffortFor(plan),
      blocked: null,
    };
  }
  // The user's own key is never read off Key Pro, so it can never be sent.
  if (explicit) return { apiKey: null, billedTo: null, model: null, effort: null, blocked: 'cloud_requires_key_pro' };
  if (!canAutoCloud(plan)) return { apiKey: null, billedTo: null, model: null, effort: null, blocked: null };

  const allowance = weeklyAllowanceUsd(plan);
  if (weeklySpentUsd >= allowance) {
    return { apiKey: null, billedTo: null, model: null, effort: null, blocked: 'allowance_exhausted' };
  }
  // No platform key configured means no platform-paid cloud, never a default.
  if (!platformKey) return { apiKey: null, billedTo: null, model: null, effort: null, blocked: null };
  return {
    apiKey: platformKey,
    billedTo: 'platform',
    model: platformModel(weeklySpentUsd, allowance),
    effort: cloudEffortFor(plan),
    blocked: null,
  };
}
