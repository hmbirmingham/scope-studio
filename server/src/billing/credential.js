import { canAutoCloud, canChooseCloud, cloudEffortFor, planFor, platformEconomy, platformModel, resolveCloudModel } from './plans.js';

const NONE = { apiKey: null, platform: false, billedTo: null, effort: null, economy: false, modelFor: () => null };

// Which way a cloud answer may go for this request, who pays for it, and how
// its model is picked — or why there is none. Every cloud call goes through
// here, so the plan rules live in one function rather than in the route.
//
// The plan, and for platform-paid plans the limits and next model, come from
// the control plane's GET /v1/me as the engine last cached it (`me`, see
// control/plan.js). A signed-out or offline engine is on Free, so it never
// gets here with a platform plan.
//
// `explicit` is a request that picks the cloud itself: the Cloud tier, or web
// search. Only Key Pro may do that, on the user's own key, which goes to
// Anthropic directly from the engine. Auto requests on Student and Engineer
// may reach the cloud through the control plane (`platform: true`), which
// holds the platform's key, meters the week's allowance and picks the model;
// the engine never holds a platform key.
//
// `modelFor(hard)` is called once the router knows whether the question is
// hard. For a platform answer it is the model the control plane said the next
// answer would use; the answer's own `done` event names the one it did use.
export function resolveCloudCredential({ plan, headerKey, explicit, modelChoice, me = null }) {
  if (canChooseCloud(plan)) {
    const model = resolveCloudModel(plan, modelChoice || process.env.CLOUD_CHAT_MODEL);
    return { apiKey: headerKey || null, platform: false, billedTo: 'user_key', effort: cloudEffortFor(plan), economy: false, blocked: null, modelFor: () => model };
  }
  // Off Key Pro the user's key and model choice are never read.
  if (explicit) return { ...NONE, blocked: 'cloud_requires_key_pro' };
  if (!canAutoCloud(plan) || !planFor(plan).platformPaid) return { ...NONE, blocked: null };

  // Checked here as well as by the control plane, so a spent allowance is
  // answered locally (or refused) without a round trip. The control plane's
  // own check is the one that counts; these figures can be a few minutes old.
  const limits = me?.limits ?? {};
  if (Number.isFinite(limits.monthlyAnswers) && Number.isFinite(limits.answersUsed) && limits.answersUsed >= limits.monthlyAnswers) {
    return { ...NONE, blocked: 'answer_limit_reached' };
  }
  const allowance = limits.weeklyAllowanceUsd;
  const spent = limits.weeklySpentUsd ?? 0;
  if (Number.isFinite(allowance) && spent >= allowance) return { ...NONE, blocked: 'allowance_exhausted' };

  const next = me?.nextModel ?? {};
  return {
    apiKey: null,
    platform: true,
    billedTo: 'platform',
    // Decided by the control plane; reported here for display only.
    effort: cloudEffortFor(plan),
    economy: Number.isFinite(allowance) ? platformEconomy(spent, allowance) : false,
    blocked: null,
    modelFor: (hard) => (hard ? next.hard : next.default) ?? platformModel(plan, { hard }),
  };
}
