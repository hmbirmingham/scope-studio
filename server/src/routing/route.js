// Tier routing per ARCHITECTURE.md §5. Retrieval runs under a provisional tier;
// the decision is made from what was actually selected, then the router
// re-packs if the final tier differs (packForTier — no second query).

export const LOCAL_TIER = 'local_7b';
export const CLOUD_TIER = 'cloud_frontier';

const DECISION_FOR_TIER = { [LOCAL_TIER]: 'local', [CLOUD_TIER]: 'cloud' };

// Local if the model can serve, else cloud — unless the user chose a tier.
export function provisionalTier({ localAvailable, preferredTier }) {
  if (preferredTier) return preferredTier;
  return localAvailable ? LOCAL_TIER : CLOUD_TIER;
}

function decision(tier, reason, available, unavailableCode) {
  return {
    decision: DECISION_FOR_TIER[tier],
    tier,
    reason,
    blocked: available ? null : unavailableCode,
  };
}

// Order is the privacy contract: a private node in context forces local and
// outranks every other input, including the user's own tier choice. If local
// cannot serve, the request is refused rather than sent anywhere else.
// Complexity- and size-based upgrades to cloud arrive with the cloud tier
// (Sprint 6), where the benchmark can calibrate them.
export function decideRoute({ selected, preferredTier, localAvailable, cloudAvailable }) {
  if (selected.some((entry) => entry.node.privacy === 'local')) {
    return decision(LOCAL_TIER, 'privacy_flag', localAvailable, 'local_unavailable');
  }
  if (preferredTier === CLOUD_TIER) {
    return decision(CLOUD_TIER, 'user_override', cloudAvailable, 'cloud_unavailable');
  }
  if (preferredTier === LOCAL_TIER) {
    return decision(LOCAL_TIER, 'user_override', localAvailable, 'local_unavailable');
  }
  if (!localAvailable) {
    return decision(CLOUD_TIER, 'no_ollama', cloudAvailable, 'cloud_unavailable');
  }
  // The provisional local pack is bounded by the local budget, so it fits.
  return decision(LOCAL_TIER, 'context_size', true, null);
}
