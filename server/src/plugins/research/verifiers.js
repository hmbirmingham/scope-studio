import { excerptById, excerptsOf, findPapers, readableProjects } from './store.js';
import { findCitations, findDois, findQuotes, normalizeDoi, normalizeText } from './text.js';

// The research verifiers. Both read the capability's structured output and
// re-read its artifacts' text, so a citation or quotation that appears only in
// prose is checked as well as the ones the capability listed. Both check
// against the library in the graph, never against what the capability says.

const MAX_REPORTED = 8;

function textsOf(result) {
  const out = [];
  if (typeof result?.output?.paragraph === 'string') out.push(result.output.paragraph);
  for (const artifact of Array.isArray(result?.artifacts) ? result.artifacts : []) {
    if (typeof artifact === 'string') out.push(artifact);
    else if (typeof artifact?.content === 'string') out.push(artifact.content);
  }
  return out;
}

function listed(items, render) {
  const shown = items.slice(0, MAX_REPORTED).map(render).join(', ');
  return items.length > MAX_REPORTED ? `${shown} and ${items.length - MAX_REPORTED} more` : shown;
}

// Every citekey and DOI the result cites, from its output and its text.
function citedBy(result) {
  const keys = new Set();
  const dois = new Set();
  for (const cite of Array.isArray(result?.output?.citations) ? result.output.citations : []) {
    const key = typeof cite === 'string' ? cite : cite?.citekey;
    if (typeof key === 'string' && key) keys.add(key.replace(/^@/, ''));
    const doi = normalizeDoi(typeof cite === 'object' ? cite?.doi : null);
    if (doi) dois.add(doi);
  }
  for (const text of textsOf(result)) {
    for (const cite of findCitations(text)) keys.add(cite.citekey);
    for (const doi of findDois(text)) dois.add(doi);
  }
  return { keys: [...keys], dois: [...dois] };
}

export async function verifyCitations(result, ctx) {
  const projects = readableProjects(ctx.agent);
  const { keys, dois } = citedBy(result);
  if (keys.length + dois.length === 0) {
    return result?.output?.requireCitations === true ? { ok: false, detail: 'the draft cites nothing; every claim needs a citation to the library' } : { ok: true, detail: 'nothing is cited' };
  }
  const papers = await findPapers({ ownerId: ctx.ownerId, projects, citekeys: keys, dois });
  const knownKeys = new Set(papers.map((paper) => paper.citekey?.toLowerCase()));
  const knownDois = new Set(papers.map((paper) => paper.doi).filter(Boolean));
  const unresolved = [...keys.filter((key) => !knownKeys.has(key.toLowerCase())).map((key) => `@${key}`), ...dois.filter((doi) => !knownDois.has(doi))];

  // A draft grounded in given excerpts may cite only the papers it was given.
  const allowed = Array.isArray(result?.output?.allowedCitekeys) ? new Set(result.output.allowedCitekeys.map((key) => String(key).toLowerCase())) : null;
  const ungrounded = allowed ? keys.filter((key) => knownKeys.has(key.toLowerCase()) && !allowed.has(key.toLowerCase())) : [];

  const problems = [];
  if (unresolved.length > 0) problems.push(`not in the library: ${listed(unresolved, (x) => x)}`);
  if (ungrounded.length > 0) problems.push(`cited without an excerpt given for it: ${listed(ungrounded, (key) => `@${key}`)}`);
  if (problems.length > 0) return { ok: false, detail: problems.join('; ') };
  return { ok: true, detail: `${keys.length + dois.length} citation${keys.length + dois.length === 1 ? '' : 's'} resolve to library items` };
}

// A quotation matches if its normalised text occurs in the normalised source.
// An elided quotation ("a ... b") matches if its parts occur in order.
export function quoteIn(quote, source) {
  const haystack = normalizeText(source);
  const parts = normalizeText(quote).split(/\s*(?:\.\.\.|\[\.\.\.\])\s*/).filter(Boolean);
  if (parts.length === 0) return false;
  let from = 0;
  for (const part of parts) {
    const at = haystack.indexOf(part, from);
    if (at === -1) return false;
    from = at + part.length;
  }
  return true;
}

// The pages of a paper's text: stored excerpts joined per page, or, for a
// paper whose PDF text was never extracted, pdftotext run now on its
// attachment. `unavailable` when neither exists and the tool is missing.
async function pageTexts(paper, ctx, pdf, page) {
  const excerpts = await excerptsOf({ ownerId: ctx.ownerId, paperId: paper.id });
  if (excerpts.length > 0) {
    const pages = new Map();
    for (const excerpt of excerpts) pages.set(excerpt.page, [...(pages.get(excerpt.page) ?? []), excerpt.text]);
    return { pages: new Map([...pages].map(([number, texts]) => [number, texts.join(' ')])) };
  }
  const attachments = (paper.attachments ?? []).filter((attachment) => attachment?.path);
  if (attachments.length === 0) return { pages: new Map() };
  const state = await pdf.status();
  if (!state.available) return { pages: new Map(), unavailable: state.reason };
  const pages = new Map();
  for (const attachment of attachments) {
    try {
      const texts = page ? await pdf.pages(attachment.path, { firstPage: page, lastPage: page }) : await pdf.pages(attachment.path);
      texts.forEach((text, i) => {
        const number = (page ?? 1) + i;
        pages.set(number, [pages.get(number), text].filter(Boolean).join(' '));
      });
    } catch {
      // An unreadable or missing PDF is simply no source text.
    }
  }
  return { pages };
}

async function checkQuote(quote, ctx, projects, pdf, citedPapers) {
  const label = `"${quote.text.length > 60 ? `${quote.text.slice(0, 57)}...` : quote.text}"`;
  if (quote.excerptId) {
    const excerpt = await excerptById({ ownerId: ctx.ownerId, projects, id: quote.excerptId });
    if (!excerpt) return { status: 'failed', detail: `${label}: excerpt ${quote.excerptId} is not in the library` };
    if (quote.page != null && excerpt.page !== quote.page) return { status: 'failed', detail: `${label}: excerpt is on p. ${excerpt.page}, not p. ${quote.page}` };
    return quoteIn(quote.text, excerpt.text) ? { status: 'ok' } : { status: 'failed', detail: `${label} is not in the excerpt it cites` };
  }

  let papers;
  if (quote.citekey) {
    papers = await findPapers({ ownerId: ctx.ownerId, projects, citekeys: [quote.citekey] });
    if (papers.length === 0) return { status: 'failed', detail: `${label} cites @${quote.citekey}, which is not in the library` };
  } else {
    // A quotation with no citation of its own is accepted only if it comes
    // from one of the papers the result does cite.
    papers = citedPapers;
    if (papers.length === 0) return { status: 'failed', detail: `${label} has no citation` };
  }

  let unavailable = null;
  const elsewhere = [];
  for (const paper of papers) {
    const { pages, unavailable: why } = await pageTexts(paper, ctx, pdf, quote.page);
    if (why) unavailable = why;
    if (quote.page != null) {
      if (pages.has(quote.page) && quoteIn(quote.text, pages.get(quote.page))) return { status: 'ok' };
      for (const [number, text] of pages) if (number !== quote.page && quoteIn(quote.text, text)) elsewhere.push(`p. ${number}`);
    } else {
      if ([...pages.values()].some((text) => quoteIn(quote.text, text))) return { status: 'ok' };
      // Without a page, the abstract and title are sources too.
      if (quoteIn(quote.text, `${paper.title ?? ''}. ${paper.text ?? ''}`) || quoteIn(quote.text, paper.text ?? '')) return { status: 'ok' };
    }
  }
  if (elsewhere.length > 0) return { status: 'failed', detail: `${label} is not on p. ${quote.page} (found on ${[...new Set(elsewhere)].join(', ')})` };
  if (unavailable) return { status: 'unavailable', detail: `${label} could not be checked: ${unavailable}` };
  const where = quote.citekey ? `@${quote.citekey}${quote.page != null ? `, p. ${quote.page}` : ''}` : 'the cited papers';
  return { status: 'failed', detail: `${label} is not in ${where}` };
}

export async function verifyQuotes(result, ctx, pdf) {
  const projects = readableProjects(ctx.agent);
  const seen = new Set();
  const quotes = [];
  const add = (quote) => {
    if (typeof quote?.text !== 'string' || !quote.text.trim()) return;
    const key = `${normalizeText(quote.text)}\u0000${quote.excerptId ?? ''}\u0000${(quote.citekey ?? '').toLowerCase()}\u0000${quote.page ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    quotes.push({ text: quote.text, excerptId: quote.excerptId ?? null, citekey: quote.citekey ? String(quote.citekey).replace(/^@/, '') : null, page: Number.isInteger(quote.page) ? quote.page : null });
  };
  (Array.isArray(result?.output?.quotes) ? result.output.quotes : []).forEach(add);
  for (const text of textsOf(result)) findQuotes(text).forEach(add);
  if (quotes.length === 0) return { ok: true, detail: 'no quotations to check' };

  const { keys, dois } = citedBy(result);
  const citedPapers = await findPapers({ ownerId: ctx.ownerId, projects, citekeys: keys, dois });
  const outcomes = [];
  for (const quote of quotes) outcomes.push(await checkQuote(quote, ctx, projects, pdf, citedPapers));
  const failed = outcomes.filter((o) => o.status === 'failed');
  const unchecked = outcomes.filter((o) => o.status === 'unavailable');
  if (failed.length > 0) return { ok: false, detail: `${failed.length} of ${quotes.length} quotation${quotes.length === 1 ? '' : 's'} do not match their source: ${listed(failed, (o) => o.detail)}` };
  if (unchecked.length > 0) return { ok: true, unavailable: true, detail: `${quotes.length - unchecked.length} quotation(s) match; ${unchecked.length} could not be checked: ${listed(unchecked, (o) => o.detail)}` };
  return { ok: true, detail: `${quotes.length} quotation${quotes.length === 1 ? '' : 's'} match their source verbatim` };
}
