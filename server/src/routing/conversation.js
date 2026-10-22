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
export function continuation(entry, { selected, tier, project }) {
  if (!entry || entry.tier !== tier) return null;
  // A different project is a different subject: continuing would keep the
  // previous repository's files in front of the model for the rest of the thread.
  if ((entry.project ?? null) !== (project ?? null)) return null;
  if (estimateTokens(entry.messages) > MAX_PROMPT_TOKENS) return null;

  const known = new Set(entry.nodeIds);
  const added = selected.filter(({ node }) => !known.has(node.id));
  // Nothing the question needs was already in context — the thread moved on,
  // so start a fresh block instead of carrying the old one along for ever.
  if (selected.length > 0 && added.length === selected.length) return null;
  return { entry, added };
}

export function saveConversation(id, ownerId, { tier, project, sources, messages, contextTokens, lastQuestion }) {
  if (!id) return;
  conversations.set(id, {
    ownerId,
    tier,
    project: project ?? null,
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

// Words that only make sense against what came before. A question with none of
// them is read on its own first: prefixing the previous question to every turn
// made a change of subject retrieve the old subject's files again, so the
// "shares nothing, start fresh" rule in continuation() could never fire.
const REFERRING = /\b(it|its|it's|that|this|these|those|they|them|their|there|he|she|his|her|same|above|previous|earlier|instead|also|else|again|more)\b/i;
const CONTINUING = /^\s*(and|but|so|then|also|or|what about|how about|why not|ok|okay)\b/i;

export function readsAsFollowUp(query) {
  return REFERRING.test(query) || CONTINUING.test(query);
}

export function resetConversations() {
  conversations.clear();
  drafts.clear();
}

// A script's output belongs in the thread: appending it keeps the cached
// prefix intact and lets the next question be about what just happened.
// It is also local-only context, unconditionally. The script runs as the user,
// outside any sandbox, so its output can hold any file on this machine: a
// private node's source, one in another project, or one never ingested at all.
// Nothing about the run's project can tell, at send time, whether the output
// holds private text, so the message is marked and the cloud never reads it
// (messagesFor).
export function rememberRunOutput(id, ownerId, run) {
  const entry = getConversation(id, ownerId);
  if (!entry) return;
  const command = `npm run ${run.script}`;
  entry.messages = [
    ...entry.messages,
    {
      role: 'user',
      content: `<command-output command="${command}" exit="${run.exitCode}">\n${run.output}\n</command-output>`,
      localOnly: { command, exitCode: run.exitCode },
    },
  ];
  entry.updatedAt = Date.now();
}

// What stands in for withheld output on a cloud request. It names only what
// the thread already showed the cloud (the script it proposed) and the exit
// code, and it is the same on every turn, so the cloud's cached prefix holds
// from one follow-up to the next.
function withheld({ command, exitCode }) {
  return (
    `<command-output command="${command}" exit="${exitCode}" withheld="true">\n` +
    'The output stayed on this machine: script output can contain private files, so it is never sent to the cloud. ' +
    'If the question needs it, say so: the user can ask with the local model, or paste the part that is safe to share.\n' +
    '</command-output>'
  );
}

export function carriesRunOutput(messages) {
  return messages.some((message) => message.localOnly);
}

// The messages a model is actually sent. The local model reads the thread as
// stored; any other destination gets each local-only message replaced by its
// stand-in. Every request is built through here, so no route, override or
// fallback can send script output to the cloud. The marker itself is never
// sent anywhere.
export function messagesFor(decision, messages) {
  return messages.map(({ localOnly, ...message }) =>
    !localOnly || decision === 'local' ? message : { ...message, content: withheld(localOnly) }
  );
}
