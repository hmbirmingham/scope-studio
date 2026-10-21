import { byline, clip, optionalInt, optionalRefs, requireText, scopeFor } from './common.js';
import { findPapers, papersByIds, scorer, searchLibrary } from './store.js';
import { ResearchError, normalizeDoi, terms, withoutDoubleQuotes } from './text.js';

// research.sweep: which papers in the library bear on a question, and the
// excerpts that make each relevant. Ranking is lexical and deterministic
// (the rarer the question's words an excerpt contains, the higher it scores),
// so the same library and question always give the same answer, offline.

const EXCERPT_CHARS = 600;
// A paper is ranked by its best excerpts with diminishing weight, so one
// strong passage counts for more than many weak ones, plus its title and
// abstract and how many of the question's words it covers at all.
const EXCERPT_WEIGHTS = [1, 0.5, 0.25];
const ABSTRACT_WEIGHT = 0.5;

// Resolves papers the caller named (citekey, DOI or id) to one paper each, in
// the caller's order, refusing names the library does not hold rather than
// quietly ignoring them. The same paper may sit in more than one ingested
// library; the run's own project wins, then the first by project name.
export async function resolveRefs(ctx, projects, refs) {
  if (!refs) return null;
  const dois = refs.map(normalizeDoi).filter(Boolean);
  const found = await findPapers({ ownerId: ctx.ownerId, projects, citekeys: refs, dois, ids: refs });
  const missing = [];
  const papers = new Map();
  for (const ref of refs) {
    const lower = ref.toLowerCase();
    const doi = normalizeDoi(ref);
    const matches = found.filter((paper) => paper.id === ref || paper.citekey?.toLowerCase() === lower || (doi && paper.doi === doi));
    if (matches.length === 0) missing.push(ref);
    else {
      const paper = matches.find((candidate) => candidate.project === ctx.project) ?? matches[0];
      papers.set(paper.id, paper);
    }
  }
  if (missing.length > 0) throw new ResearchError('unknown_papers', `not in the library: ${missing.join(', ')}`);
  return [...papers.values()];
}

// Ranked papers for a set of query words, each with its best excerpts.
export async function rankPapers(ctx, { projects, words, paperIds = null, maxPapers, excerptsPerPaper }) {
  const rows = await searchLibrary({ ownerId: ctx.ownerId, projects, words, paperIds });
  const textOf = (row) => (row.kind === 'paper' ? `${row.title ?? ''} ${row.text}` : row.text);
  const score = scorer(words, rows.map(textOf));

  const byPaper = new Map();
  for (const row of rows) {
    if (!row.paperId) continue; // a standalone note belongs to no paper
    const entry = byPaper.get(row.paperId) ?? { paper: null, excerpts: [], notes: [], matched: new Set() };
    const { score: value, matched } = score(textOf(row));
    if (value <= 0) continue;
    matched.forEach((word) => entry.matched.add(word));
    if (row.kind === 'paper') entry.paper = { ...row, score: value };
    else if (row.kind === 'excerpt') entry.excerpts.push({ ...row, score: value, matched });
    else entry.notes.push({ ...row, score: value, matched });
    byPaper.set(row.paperId, entry);
  }

  // Papers that matched only through an excerpt or note still need their
  // bibliographic record.
  const missing = [...byPaper.entries()].filter(([, entry]) => !entry.paper).map(([id]) => id);
  for (const paper of await papersByIds({ ownerId: ctx.ownerId, projects, ids: missing })) {
    byPaper.get(paper.id).paper = { ...paper, score: 0 };
  }

  const ranked = [];
  for (const [paperId, entry] of byPaper) {
    if (!entry.paper) continue;
    entry.excerpts.sort((a, b) => b.score - a.score || a.page - b.page || a.chunk - b.chunk);
    const best = entry.excerpts.slice(0, EXCERPT_WEIGHTS.length).reduce((sum, excerpt, i) => sum + excerpt.score * EXCERPT_WEIGHTS[i], 0);
    const coverage = entry.matched.size / words.length;
    const total = best + entry.paper.score * ABSTRACT_WEIGHT + coverage;
    ranked.push({ paperId, paper: entry.paper, score: total, matched: [...entry.matched], excerpts: entry.excerpts.slice(0, excerptsPerPaper), notes: entry.notes.slice(0, 2) });
  }
  ranked.sort((a, b) => b.score - a.score || String(a.paper.citekey).localeCompare(String(b.paper.citekey)));
  return ranked.slice(0, maxPapers);
}

function present(entry) {
  const { paper } = entry;
  return {
    paperId: paper.id,
    citekey: paper.citekey,
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    doi: paper.doi,
    project: paper.project,
    score: Math.round(entry.score * 1000) / 1000,
    matched: entry.matched,
    excerpts: entry.excerpts.map((excerpt) => ({ excerptId: excerpt.id, page: excerpt.page, text: clip(excerpt.text, EXCERPT_CHARS), matched: excerpt.matched })),
    notes: entry.notes.map((note) => ({ noteId: note.id, text: clip(note.text, EXCERPT_CHARS) })),
  };
}

// The report shows library text without its double quotes: the excerpts are
// checked through the structured output, and a quote mark left in one excerpt
// would otherwise pair with one in the next line and fail the verifier.
export function sweepReport(question, papers) {
  const shown = withoutDoubleQuotes;
  if (papers.length === 0) return `Literature sweep: ${shown(question)}\n\nNothing in the library matches this question.`;
  const lines = [`Literature sweep: ${shown(question)}`, ''];
  papers.forEach((paper, i) => {
    lines.push(`${i + 1}. ${shown(paper.title ?? '(untitled)')} (${shown(byline(paper))}) [@${paper.citekey}]${paper.doi ? ` doi:${paper.doi}` : ''} · score ${paper.score}`);
    for (const excerpt of paper.excerpts) lines.push(`   > p. ${excerpt.page}: ${shown(excerpt.text)}`);
  });
  return lines.join('\n');
}

export async function sweep(input, ctx) {
  const question = requireText(input, 'question');
  const maxPapers = optionalInt(input, 'maxPapers', { min: 1, max: 50, fallback: 10 });
  const excerptsPerPaper = optionalInt(input, 'excerptsPerPaper', { min: 1, max: 5, fallback: 3 });
  const projects = scopeFor(ctx, input);
  const words = terms(question);
  if (words.length === 0) throw new ResearchError('invalid_input', 'the question has no words to search for');
  const named = await resolveRefs(ctx, projects, optionalRefs(input, 'papers'));

  const ranked = await rankPapers(ctx, { projects, words, paperIds: named?.map((paper) => paper.id) ?? null, maxPapers, excerptsPerPaper });
  const papers = ranked.map(present);
  const quotes = papers.flatMap((paper) => paper.excerpts.map((excerpt) => ({ text: excerpt.text, excerptId: excerpt.excerptId, citekey: paper.citekey, page: excerpt.page })));
  return {
    output: {
      question,
      terms: words,
      papers,
      citations: papers.map((paper) => ({ citekey: paper.citekey, doi: paper.doi })),
      quotes,
    },
    touchedNodeIds: papers.flatMap((paper) => [paper.paperId, ...paper.excerpts.map((excerpt) => excerpt.excerptId)]),
    artifacts: [{ name: `Literature sweep: ${clip(question, 120)}`, content: sweepReport(question, papers) }],
    findings: papers.length > 0 ? [`For "${clip(question, 200)}" the library's most relevant papers are ${papers.slice(0, 5).map((p) => `@${p.citekey}`).join(', ')}.`] : [],
  };
}
