// The search tier. Baseline facts about the world — the things the vault does
// not contain and a local model should not be trusted to recall — come from
// Gemini with Google Search grounding, on the free key.
//
// This is a SOURCE tier, not a reasoning tier. It fetches material with
// citations; judgement stays with headless Claude Code on the Pro plan, and
// volume stays local. It is also the only tier that reaches a third party, so:
//
// PRIVACY: Google's free tier trains on submitted data. Nothing from the vault,
// nothing from a private repo, nothing the user typed as a private note is ever
// sent here. Only outbound questions about the world. This is enforced below
// rather than left to a convention, because a convention would be broken the
// first time a task was convenient.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-2.5-flash';

export class PrivacyRefusal extends Error {}

/**
 * Anything that looks like it came off this machine rather than out of the
 * user's head. Deliberately crude and deliberately fail-closed: a false
 * refusal costs a rephrased question, a false allow costs a leak that cannot
 * be undone.
 */
export function privacyViolations(query) {
  const found = [];
  if (/<source\b/i.test(query)) found.push('source material block');
  if (/^---$|\n---\n/m.test(query) && /granola_id|granola_updated_at/i.test(query)) {
    found.push('vault note frontmatter');
  }
  if (/\[\[[^\]]+\]\]/.test(query)) found.push('vault wikilink');
  if (/\/Users\/[^/\s]+\//.test(query)) found.push('local filesystem path');
  if (/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,})\b/.test(query)) {
    found.push('credential-shaped string');
  }
  return found;
}

function assertSendable(query) {
  const violations = privacyViolations(query);
  if (violations.length) {
    throw new PrivacyRefusal(
      `refusing to send this to Google: it contains ${violations.join(', ')}. ` +
        `The search tier takes questions about the world, never material from this machine.`
    );
  }
}

/**
 * Pull the grounding citations out of a response. Defensive on purpose: this
 * shape is Google's to change, and a search result with no citations is worse
 * than useless here, since the whole point is material the gates can check.
 */
export function parseGrounding(body) {
  const candidate = body?.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((part) => part?.text ?? '')
    .join('')
    .trim();

  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const sources = chunks
    .map((chunk) => chunk?.web)
    .filter(Boolean)
    .map((web) => ({ title: web.title ?? null, uri: web.uri ?? null }))
    .filter((s) => s.uri);

  // The supports tie spans of the answer to the chunks behind them, which is
  // exactly the claim-to-quote relation the analysis layer already models.
  const supports = (candidate?.groundingMetadata?.groundingSupports ?? [])
    .map((support) => ({
      text: support?.segment?.text ?? null,
      sourceIndexes: support?.groundingChunkIndices ?? [],
    }))
    .filter((s) => s.text);

  return { text, sources, supports };
}

/** Is a key configured at all? `doctor` asks this; nothing else should. */
export function searchConfigured(config) {
  return Boolean(config.search?.apiKey);
}

/**
 * One grounded search. Returns the answer, its citations, and the citations
 * rendered as source material the existing gates can ground quotes against.
 */
export async function search(config, { query, timeoutMs = 60_000 }) {
  const apiKey = config.search?.apiKey;
  if (!apiKey) {
    throw new Error('no search key: set GEMINI_API_KEY (see `scope doctor`)');
  }
  assertSendable(query);

  const started = Date.now();
  let res;
  try {
    res = await fetch(`${ENDPOINT}/${config.search.model ?? MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(`search timed out after ${timeoutMs}ms`);
    throw new Error(`search unreachable: ${err.message}`);
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`search returned HTTP ${res.status}: ${detail}`);
  }

  const { text, sources, supports } = parseGrounding(await res.json());
  return {
    output: text,
    sources,
    supports,
    // Rendered the same way vault sources are, so a task can ground its quotes
    // against fetched material without knowing where it came from.
    sourceText: sources
      .map((s, i) => `<source index="${i + 1}" uri="${s.uri}">\n${s.title ?? ''}\n</source>`)
      .join('\n\n'),
    model: `gemini/${config.search.model ?? MODEL}`,
    ms: Date.now() - started,
  };
}
