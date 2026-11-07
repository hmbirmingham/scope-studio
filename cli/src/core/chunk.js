// Splitting source material into retrievable pieces.
//
// This exists because of a measured failure, not a design preference: two
// Wikipedia pages came to ~13,500 estimated tokens against an 8,192-token
// window, and Ollama drops whatever overflows without saying so. Refusing the
// run was the honest first fix. Choosing which parts to send is the real one.
//
// A chunk is a piece of one source, in document order, carrying the heading it
// sat under. The heading matters twice: it is the cheapest relevance signal a
// page offers, and it is what makes an excerpt readable once its neighbours
// have been left out.

import { estimateTokens } from '../runners/local.js';

// ~800 tokens is small enough that several fit a local window with room for an
// answer, and large enough to hold a whole argument rather than half of one.
// A quote that straddles two chunks cannot ground, so bigger is safer than
// smaller and this is the largest size that still lets a handful through.
export const CHUNK_TARGET_TOKENS = 800;

const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * Split text into chunks on structural boundaries.
 *
 * The atomic unit is a line, not a paragraph: markdown separates paragraphs
 * with blank lines but HTML-derived text separates them with single newlines,
 * and a chunker that only broke on blank lines would turn a whole page section
 * into one oversized chunk. A line is never split, because a half-sentence is
 * unquotable — it would break grounding for a reason the model can neither see
 * nor fix.
 *
 * A continuation chunk carries its section's heading in metadata only, never as
 * an injected line. The chunk body has to stay byte-for-byte what the source
 * said: quotes ground against this text, so any synthetic line added here would
 * become quotable material the page never contained.
 *
 * @returns {Array<{text: string, heading: string|null, index: number, tokens: number}>}
 */
export function chunkText(text, { targetTokens = CHUNK_TARGET_TOKENS } = {}) {
  const chunks = [];
  let heading = null;
  let buffer = [];
  let tokens = 0;
  // Whether anything but the section's own heading line is in the buffer. A
  // heading alone is not a chunk — flushing one would spend a slot on a label.
  let hasBody = false;

  const flush = () => {
    const body = buffer.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    buffer = [];
    tokens = 0;
    hasBody = false;
    if (body) chunks.push({ text: body, heading, index: chunks.length, tokens: estimateTokens(body) });
  };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();

    // A heading starts a new chunk: it is a boundary the author put there, and
    // keeping it with the text beneath it is what lets a chunk describe itself.
    const found = HEADING.exec(line.trim());
    if (found) {
      flush();
      heading = found[2].trim();
      // The heading line travels with its text rather than being stripped, so
      // the model sees the page's own structure and can quote it.
      buffer.push(line.trim());
      tokens = estimateTokens(line);
      continue;
    }

    const cost = estimateTokens(line);
    if (hasBody && tokens + cost > targetTokens) flush();
    buffer.push(line);
    tokens += cost;
    if (line.trim()) hasBody = true;
  }
  flush();
  return chunks;
}

/**
 * Chunk one labelled source. The label is kept on every chunk so a selected
 * excerpt can still say which page it came from — an unattributed excerpt is
 * not groundable material, it is just text.
 */
export function chunkSource(source, options) {
  return chunkText(source.text, options).map((chunk) => ({ ...chunk, source }));
}
