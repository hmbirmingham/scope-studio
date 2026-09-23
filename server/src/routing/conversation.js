// Keeping the context block byte-identical across a conversation is what makes
// follow-ups fast: the model's KV cache is reused instead of reprocessing ~1,600
// tokens. Measured on qwen3:4b — 4.79 s cold vs 0.12–0.41 s against a cached
// context. State is per-process and in memory, which suits the desktop target;
// losing it costs one cold prefill.

const MAX_CONVERSATIONS = 50;
const TTL_MS = 2 * 60 * 60 * 1000;
// Past this the prompt is trimmed, which would invalidate the cache anyway, so
// the next question starts a fresh context block instead.
const MAX_PROMPT_TOKENS = 6000;

// The last context block prepared for a session. A reworded question that the
// block still covers reuses it verbatim, so the prefill already done is not
// thrown away just because the wording changed.
const DRAFT_TTL_MS = 10 * 60 * 1000;
const MAX_DRAFTS = 50;

const conversations = new Map();
const drafts = new Map();

export function draftKey(ownerId, sessionId) {
  return `${ownerId}:${sessionId}`;
}

export function saveDraft(key, { tier, sources, contextBlock, contextTokens }) {
  drafts.set(key, { tier, sources, contextBlock, contextTokens, updatedAt: Date.now() });
  while (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value);
}

export function coveringDraft(key, { selected, tier }) {
  const draft = drafts.get(key);
  if (!draft || draft.tier !== tier) return null;
  if (Date.now() - draft.updatedAt > DRAFT_TTL_MS) {
    drafts.delete(key);
    return null;
  }
  const known = new Set(draft.sources.map(({ node }) => node.id));
  return selected.every(({ node }) => known.has(node.id)) ? draft : null;
}

export function estimateTokens(messages) {
  return Math.ceil(messages.reduce((total, message) => total + message.content.length, 0) / 4);
}

export function getConversation(id, ownerId) {
  if (!id) return null;
  const entry = conversations.get(id);
  if (!entry) return null;
  if (entry.ownerId !== ownerId || Date.now() - entry.updatedAt > TTL_MS) {
    conversations.delete(id);
    return null;
  }
  conversations.delete(id);
  conversations.set(id, entry);
  return entry;
}

// A follow-up continues the conversation whenever the prompt still fits: nodes
// the cached context lacks are appended as a new block rather than triggering a
// rebuild. Rebuilding would drop the cached prefix — the expensive part — while
// appending keeps it and still puts the new evidence in front of the model.
export function continuation(entry, { selected, tier }) {
  if (!entry || entry.tier !== tier) return null;
  if (estimateTokens(entry.messages) > MAX_PROMPT_TOKENS) return null;
  const known = new Set(entry.nodeIds);
  return { entry, added: selected.filter(({ node }) => !known.has(node.id)) };
}

export function saveConversation(id, ownerId, { tier, sources, messages, contextTokens, lastQuestion }) {
  if (!id) return;
  conversations.set(id, {
    ownerId,
    tier,
    sources,
    messages,
    contextTokens,
    lastQuestion,
    nodeIds: sources.map(({ node }) => node.id),
    updatedAt: Date.now(),
  });
  while (conversations.size > MAX_CONVERSATIONS) {
    conversations.delete(conversations.keys().next().value);
  }
}

// A follow-up like "and where is that invalidated?" carries little on its own;
// retrieving on the previous question plus the new one keeps the subject in
// the query, which also makes a cache-preserving reuse more likely.
export function retrievalQuery(entry, query) {
  return entry?.lastQuestion ? `${entry.lastQuestion} ${query}` : query;
}

export function resetConversations() {
  conversations.clear();
  drafts.clear();
}
