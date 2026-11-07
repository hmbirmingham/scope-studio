// Choosing which chunks of the source material the model actually sees.
//
// Ported from the server's retrieval scoring, with the database taken out. The
// shape that survives is the one that was benchmarked: rank lexically, rank
// densely, fuse the two ranks with RRF, multiply by boosts, then pack into the
// token budget in score order. What does not survive is everything that needed
// a corpus — document-frequency thresholds are computed over this run's chunks,
// not over 871 stored ones, so they mean "rare on this page" rather than "rare
// in my notes".
//
// Two rules this layer has to respect, both learned elsewhere:
//
// 1. Selection is computed ONCE per run, from the question, before the first
//    attempt. If it were recomputed per attempt the grounding gate would be
//    checking quotes against a source that moved between attempts, and a
//    correction could fail for a reason the model could not see.
// 2. Selection can starve the gates. If the chunk holding the answer is left
//    out, the model fails `cited` and `min_claims` for a reason it cannot fix,
//    and the correction loop burns every attempt. So what was left out is
//    reported and recorded, and a selection is never empty while the budget
//    allows one chunk.

import { estimateTokens } from '../runners/local.js';
import { chunkSource } from './chunk.js';
import { denseScores } from './embed.js';

export const RRF_K = 60;
export const LEXICAL_MIN_MATCH = 2;
// A term matching at most this fraction of the chunks is discriminative enough
// to count as a hit on its own. The server calibrated 10% against a live
// 871-chunk corpus; the same number over a handful of pages is a weaker claim,
// so it is kept rather than re-derived from a sample too small to argue with.
export const RARE_TERM_MAX_DF = 0.1;
// A chunk whose own heading names what was asked is the page-shaped version of
// the server's definition boost: the section called "Discounted cumulative
// gain" is the answer to a question about DCG, while the chunks that merely
// mention it are usages. Same magnitude as the project boost, not the 2.0 the
// definition boost needed — a heading is suggestive, not decisive.
export const HEADING_BOOST = 0.3;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one',
  'our', 'out', 'has', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'way', 'who',
  'did', 'get', 'let', 'say', 'she', 'too', 'use', 'what', 'does', 'this', 'that', 'with',
  'from', 'have', 'they', 'will', 'your', 'when', 'where', 'which', 'there', 'their', 'about',
  'would', 'could', 'should', 'into', 'than', 'then', 'them', 'these', 'those', 'over', 'why',
  'self', 'standard', 'ways', 'people',
]);

/** Mirrors the server's index side: identifiers split on non-alphanumerics. */
export function lexicalTerms(query) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
  return [...new Set(terms)];
}

function matchedTerms(text, terms) {
  const haystack = text.toLowerCase();
  return terms.filter((term) => haystack.includes(term));
}

/**
 * Which terms are rare enough that a single match is signal. Over one page's
 * chunks this is a blunt instrument, which is why it only ever *admits* a
 * candidate — it never promotes one past the fused ranking.
 */
export function rareTerms(chunks, terms) {
  if (chunks.length === 0) return new Set();
  const ceiling = Math.max(1, Math.floor(chunks.length * RARE_TERM_MAX_DF));
  const rare = new Set();
  for (const term of terms) {
    const docs = chunks.filter((chunk) => chunk.text.toLowerCase().includes(term)).length;
    if (docs > 0 && docs <= ceiling) rare.add(term);
  }
  return rare;
}

/**
 * Rank chunks by term overlap. A hit needs several matched terms — one shared
 * common word is noise RRF would otherwise reward — unless a matched term is
 * rare, in which case one is enough.
 */
export function lexicalRanking(chunks, terms) {
  if (terms.length === 0) return [];
  const rare = rareTerms(chunks, terms);
  const minMatch = Math.min(LEXICAL_MIN_MATCH, terms.length);
  return chunks
    .map((chunk) => {
      const matched = matchedTerms(chunk.text, terms);
      const admitted = matched.length >= minMatch || matched.some((term) => rare.has(term));
      return { chunk, matched, admitted };
    })
    .filter((entry) => entry.admitted)
    // Term frequency is deliberately not used: a long chunk repeating a word is
    // not more relevant than a short one answering the question.
    .sort((a, b) => b.matched.length - a.matched.length)
    .map(({ chunk, matched }) => ({ chunk, matched }));
}

function headingBoost(chunk, terms) {
  if (!chunk.heading || terms.length === 0) return 0;
  return matchedTerms(chunk.heading, terms).length > 0 ? HEADING_BOOST : 0;
}

/**
 * Fuse the two rankings. Boosts multiply the fused score rather than adding to
 * a similarity, for the reason the server recorded: nomic similarities cluster
 * in a narrow band, so an additive bump re-orders across relevance tiers.
 */
export function fuse({ chunks, terms, lexical, dense, k = RRF_K }) {
  const byIndex = new Map();
  const key = (chunk) => `${chunk.source.label}#${chunk.index}`;

  lexical.forEach(({ chunk, matched }, i) => {
    byIndex.set(key(chunk), { chunk, matched, rrf: 1 / (k + i + 1), similarity: null });
  });
  if (dense) {
    [...dense]
      .sort((a, b) => b.similarity - a.similarity)
      .forEach(({ chunk, similarity }, i) => {
        const entry = byIndex.get(key(chunk)) ?? { chunk, matched: [], rrf: 0, similarity: null };
        entry.rrf += 1 / (k + i + 1);
        entry.similarity = similarity;
        byIndex.set(key(chunk), entry);
      });
  }

  // Nothing matched and no embeddings: fall back to document order rather than
  // returning nothing. A page with no term overlap is usually a sign the task
  // named the wrong page, and showing its opening says so faster than an empty
  // selection does.
  if (byIndex.size === 0) {
    chunks.forEach((chunk, i) => byIndex.set(key(chunk), { chunk, matched: [], rrf: 1 / (k + i + 1), similarity: null }));
  }

  return [...byIndex.values()]
    .map((entry) => ({ ...entry, score: entry.rrf * (1 + headingBoost(entry.chunk, terms)) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Pack the highest-scoring chunks into the budget. The first chunk is always
 * taken, even if it alone exceeds the budget: a run that sends nothing is
 * strictly worse than one that sends its best guess and says it overflowed.
 */
export function pack(ranked, budgetTokens) {
  const taken = [];
  let tokens = 0;
  for (const entry of ranked) {
    if (taken.length === 0) {
      taken.push(entry);
      tokens = entry.chunk.tokens;
      continue;
    }
    if (tokens + entry.chunk.tokens > budgetTokens) continue;
    taken.push(entry);
    tokens += entry.chunk.tokens;
  }
  return { taken, tokens, overflowed: tokens > budgetTokens };
}

/**
 * Shrink a packed selection until the text that will actually be sent fits.
 *
 * Packing counts chunk tokens; the prompt carries the rendered form, with its
 * `<source>` wrappers and elision markers. The first live two-page run packed
 * 6,745 chunk tokens inside budget and rendered 43 tokens over the window — so
 * the budget has to be checked against the rendering, not against the sum.
 * Measuring beats estimating the overhead: the markers depend on which chunks
 * were dropped, which is what this loop changes.
 */
export function fitRendered(taken, budgetTokens) {
  let kept = [...taken];
  let text = render(kept);
  while (kept.length > 1 && estimateTokens(text) > budgetTokens) {
    // Lowest-scoring first: the ranking already said which chunk is worth least.
    const weakest = kept.reduce((worst, entry) => (entry.score < worst.score ? entry : worst), kept[0]);
    kept = kept.filter((entry) => entry !== weakest);
    text = render(kept);
  }
  return { kept, text, tokens: estimateTokens(text) };
}

/**
 * Render selected chunks back into the `<source>` blocks every gate already
 * understands, in document order per source. Order is restored because an
 * excerpt list in score order reads as non-sequitur prose, and because a model
 * asked to summarise a page should see it the way the page runs.
 *
 * Elisions are marked. The marker is what tells the model its material has
 * gaps, so it does not assert continuity the page never claimed.
 */
export function render(taken) {
  const bySource = new Map();
  for (const { chunk } of taken) {
    if (!bySource.has(chunk.source.label)) bySource.set(chunk.source.label, { source: chunk.source, chunks: [] });
    bySource.get(chunk.source.label).chunks.push(chunk);
  }

  const blocks = [];
  for (const { source, chunks } of bySource.values()) {
    const ordered = [...chunks].sort((a, b) => a.index - b.index);
    const parts = [];
    let previous = null;
    for (const chunk of ordered) {
      if (previous !== null && chunk.index !== previous + 1) parts.push('[...]');
      parts.push(chunk.text);
      previous = chunk.index;
    }
    if (ordered[0].index > 0) parts.unshift('[...]');
    blocks.push(`<source ${source.attr}="${source.ref}" excerpt="true">\n${parts.join('\n\n')}\n</source>`);
  }
  return blocks.join('\n\n');
}

/**
 * Select enough of the source material to answer the question inside a token
 * budget.
 *
 * @param {object} config
 * @param {string} question the task's own prompt — never a previous answer
 * @param {Array<{label: string, attr: string, ref: string, text: string}>} sources
 * @param {number} budgetTokens what is left of the window after the prompt
 */
export async function select(config, question, sources, budgetTokens) {
  const chunks = sources.flatMap((source) => chunkSource(source));
  const terms = lexicalTerms(question);
  const lexical = lexicalRanking(chunks, terms);
  const dense = await denseScores(config, question, chunks);
  const ranked = fuse({ chunks, terms, lexical, dense, k: RRF_K });
  const packed = pack(ranked, budgetTokens);
  const { kept, text, tokens } = fitRendered(packed.taken, budgetTokens);

  return {
    text,
    tokens,
    chunkTokens: kept.reduce((sum, entry) => sum + entry.chunk.tokens, 0),
    overflowed: tokens > budgetTokens,
    dense: dense !== null,
    terms,
    selected: kept.length,
    total: chunks.length,
    // What was left out, named. A gate failure caused by selection and one
    // caused by the model look identical in the output, so the trace has to be
    // able to tell them apart.
    elided: chunks.length - kept.length,
  };
}
