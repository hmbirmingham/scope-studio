// Text handling shared by the research ingest, capabilities and verifiers:
// normalising what pdftotext and models produce so a quote can be compared
// with its source, chunking pages into excerpts, and reading citations
// (Pandoc style, `[@citekey, p. 3]`) and DOIs out of prose.

export class ResearchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Typographic variants a PDF or a model may use for the same character. A
// quote is "verbatim" if it matches after these and whitespace are folded,
// and nothing else: case and wording still have to match exactly.
const FOLD = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—−]/g, '-'],
  [/…/g, '...'],
  [/­/g, ''],
];

export function normalizeText(text) {
  let out = String(text ?? '').normalize('NFKC');
  for (const [pattern, replacement] of FOLD) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, ' ').trim();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Zotero stores notes as HTML. Only the text matters to the graph.
export function htmlToText(html) {
  return normalizeText(
    String(html ?? '')
      .replace(/<(br|\/p|\/div|\/li|\/h\d)\b[^>]*>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
        if (entity[0] === '#') {
          const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
          return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
        }
        return ENTITIES[entity.toLowerCase()] ?? match;
      })
  );
}

const STOPWORDS = new Set(
  ('a an and are as at be by can do does for from has have how in into is it its of on or that the their them these this those to was ' +
    'were what when where which who why will with than then there our we you your not no all any each per via vs about over under ' +
    'paper papers report reports reported study studies show shows method methods use used using').split(' ')
);

// The search terms of a question: lower-case words, stopwords dropped, each
// once, in order. Digits stay ("18.2", "512") because results are numbers.
export function terms(text, { max = 24 } = {}) {
  const seen = new Set();
  for (const word of normalizeText(text).toLowerCase().match(/[\p{L}\p{N}]+(?:\.[\p{N}]+)?/gu) ?? []) {
    if (word.length < 2 || STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    if (seen.size >= max) break;
  }
  return [...seen];
}

// A DOI compared case-insensitively and without its resolver prefix, which is
// how DOIs are defined to compare.
export function normalizeDoi(value) {
  if (typeof value !== 'string') return null;
  const doi = value
    .trim()
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '')
    .replace(/[.,;:)\]]+$/, '')
    .toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : null;
}

const DOI_PATTERN = /\b10\.\d{4,9}\/[^\s"'<>\]]+/gi;

export function findDois(text) {
  const found = new Set();
  for (const match of String(text ?? '').match(DOI_PATTERN) ?? []) {
    const doi = normalizeDoi(match);
    if (doi) found.add(doi);
  }
  return [...found];
}

// Pandoc citation groups: `[@key]`, `[@key, p. 3]`, `[@a; @b, pp. 2-3]`.
const CITATION_GROUP = /\[([^\[\]]*@[^\[\]]*)\]/g;
const CITATION = /@([\p{L}\p{N}_][\p{L}\p{N}_:.#+\-/]*)(?:\s*,\s*(?:pp?\.?|page)\s*(\d+))?/gu;

function cleanKey(key) {
  return key.replace(/[.:]+$/, '');
}

export function findCitations(text) {
  const out = [];
  for (const group of String(text ?? '').matchAll(CITATION_GROUP)) {
    for (const cite of group[1].matchAll(CITATION)) {
      out.push({ citekey: cleanKey(cite[1]), page: cite[2] ? Number(cite[2]) : null });
    }
  }
  return out;
}

// A direct quotation in prose: a span in double quotes followed by the
// citation it comes from. A quoted span of three or more words with no
// citation is reported too (citekey null), since the verifier cannot tie it
// to a source and must say so.
const QUOTE = /["“]([^"“”]{3,600}?)["”]\s*(\[[^\[\]]*@[^\[\]]*\])?/g;

export function findQuotes(text) {
  const out = [];
  for (const match of String(text ?? '').matchAll(QUOTE)) {
    const quoted = normalizeText(match[1]);
    if (quoted.split(' ').length < 3) continue;
    const cite = match[2] ? findCitations(match[2])[0] : null;
    out.push({ text: quoted, citekey: cite?.citekey ?? null, page: cite?.page ?? null });
  }
  return out;
}

// Splits each page's text into excerpts of at most `maxChars`, at a sentence
// end where there is one and otherwise at a space. Chunks do not overlap and
// never cross a page, so every excerpt has exactly one page number and a
// page's excerpts joined with spaces are the page's (normalised) text.
export function chunkPages(pages, { maxChars = 1200 } = {}) {
  const chunks = [];
  pages.forEach((pageText, index) => {
    let rest = normalizeText(pageText);
    let chunk = 0;
    while (rest.length > 0) {
      let cut = rest.length;
      if (rest.length > maxChars) {
        const window = rest.slice(0, maxChars);
        const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
        const space = window.lastIndexOf(' ');
        cut = sentence >= maxChars / 2 ? sentence + 1 : space > 0 ? space : maxChars;
      }
      const text = rest.slice(0, cut).trim();
      rest = rest.slice(cut).trim();
      if (text) {
        chunks.push({ page: index + 1, chunk, text });
        chunk += 1;
      }
    }
  });
  return chunks;
}
