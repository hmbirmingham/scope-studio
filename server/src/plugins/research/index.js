import { extract } from './extract.js';
import { SOURCE, ingestLibrary } from './ingest.js';
import { defaultPdfText } from './pdf.js';
import { relatedWork } from './relatedWork.js';
import { sweep } from './sweep.js';
import { verifyCitations, verifyQuotes } from './verifiers.js';
import { providerFromEnv, webSearch } from './webSearch.js';

// The research vertical (docs/architecture/agent-workspace.md, "Verticals").
// A Zotero library is ingested into the graph as papers, notes and page
// excerpts (ingest.js, run from routes/plugins/research.js); these
// capabilities work over it. Everything except web search runs offline.

const CITATION_VERIFIERS = ['research.citations_resolve', 'research.quotes_match'];

const refList = { type: 'array', items: { type: 'string' }, description: 'Citekeys, DOIs or paper node ids.' };

// `pdf` (pdftotext) and `webSearch` (a search provider) are injectable so
// tests can run without poppler and without the network.
export function createResearchPlugin({ pdf = defaultPdfText, webSearchProvider = providerFromEnv() } = {}) {
  return {
    name: 'research',
    ingest: (options) => ingestLibrary({ pdf, ...options }),
    capabilities: [
      {
        name: 'research.sweep',
        description: 'Rank the library’s papers for a question, with the excerpts that make each relevant.',
        tags: ['research'],
        permission: 'read_graph',
        source: SOURCE,
        input: {
          type: 'object',
          required: ['question'],
          properties: {
            question: { type: 'string' },
            papers: refList,
            project: { type: 'string', description: 'Only the library ingested as this project.' },
            maxPapers: { type: 'integer', minimum: 1, maximum: 50 },
            excerptsPerPaper: { type: 'integer', minimum: 1, maximum: 5 },
          },
        },
        verifiers: CITATION_VERIFIERS,
        run: sweep,
      },
      {
        name: 'research.extract',
        description: 'Fill an extraction table: one row per paper, each cell with its supporting excerpt, page and quote.',
        tags: ['research'],
        permission: 'read_graph',
        source: SOURCE,
        input: {
          type: 'object',
          required: ['columns'],
          properties: {
            columns: { type: 'array', items: { type: ['string', 'object'] }, description: 'Column names, or { name, question }.' },
            papers: refList,
            question: { type: 'string', description: 'Finds the papers when none are named.' },
            project: { type: 'string' },
            maxPapers: { type: 'integer', minimum: 1, maximum: 10 },
          },
        },
        verifiers: CITATION_VERIFIERS,
        run: extract,
      },
      {
        name: 'research.related_work',
        description: 'Draft a related-work paragraph with [@citekey] citations, grounded only in the library’s excerpts.',
        tags: ['research'],
        permission: 'read_graph',
        source: SOURCE,
        input: {
          type: 'object',
          required: ['topic'],
          properties: {
            topic: { type: 'string' },
            papers: refList,
            project: { type: 'string' },
            maxPapers: { type: 'integer', minimum: 1, maximum: 8 },
            maxWords: { type: 'integer', minimum: 50, maximum: 600 },
          },
        },
        verifiers: CITATION_VERIFIERS,
        run: relatedWork,
      },
      {
        name: 'research.web_search',
        description: 'Search the web (needs the web permission and an online engine).',
        // The web tag too: a role that may search the web reaches it.
        tags: ['research', 'web'],
        permission: 'web',
        input: {
          type: 'object',
          required: ['query'],
          properties: { query: { type: 'string' }, maxResults: { type: 'integer', minimum: 1, maximum: 10 } },
        },
        verifiers: [],
        run: (input, ctx) => webSearch(input, ctx, webSearchProvider),
      },
    ],
    verifiers: [
      { name: 'research.citations_resolve', tags: ['research'], verify: (result, ctx) => verifyCitations(result, ctx) },
      { name: 'research.quotes_match', tags: ['research'], verify: (result, ctx) => verifyQuotes(result, ctx, pdf) },
    ],
  };
}

export default createResearchPlugin();
