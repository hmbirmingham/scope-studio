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
// Auto then answers locally unless the question is hard (routing/difficulty.js)
// and a cloud credential exists: the most efficient path, never cloud for a
// question the local model handles.
export function decideRoute({ selected, preferredTier, localAvailable, cloudAvailable, hard = false }) {
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
  if (hard && cloudAvailable) {
    return decision(CLOUD_TIER, 'complexity', true, null);
  }
  // The provisional local pack is bounded by the local budget, so it fits.
  return decision(LOCAL_TIER, 'context_size', true, null);
}

// Decides the route and packs the context that will actually be sent. The
// decision is made on the provisional pack; when the tier changes, the context
// is re-packed for it, and a cloud pack is larger than a local one, so it can
// reach a private node the provisional pack stopped short of (a hard question
// re-packed from 5 nodes to 10, say). The final pack is therefore checked
// again: a private node in it forces local, exactly as one in the provisional
// pack would have. `pack(tier)` returns { selected, tokens } for a tier.
export function routeAndPack({ pack, provisional, ...inputs }) {
  let packed = pack(provisional);
  let route = decideRoute({ ...inputs, selected: packed.selected });
  if (route.tier === provisional) return { route, packed };
  packed = pack(route.tier);
  if (sendsPrivate(route, packed.selected)) {
    // Privacy outranks every other input, so this decides local (or refuses
    // when local cannot serve); the decision never goes back to the cloud.
    route = decideRoute({ ...inputs, selected: packed.selected });
    packed = pack(route.tier);
  }
  return { route, packed };
}

// True when a cloud answer would send a private node: the last guard on what
// leaves the machine, for context assembled outside the pack (a continued
// conversation, a prefilled draft).
export function sendsPrivate(route, entries) {
  return route.decision === 'cloud' && entries.some(({ node }) => node.privacy === 'local');
}
