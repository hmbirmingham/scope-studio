import { extractJsonObject } from '../../workspace/runner/chooser.js';
import { assertModelMayRead, byline, clip, complete, optionalInt, optionalRefs, requireText, scopeFor } from './common.js';
import { excerptsOf, scorer } from './store.js';
import { rankPapers, resolveRefs } from './sweep.js';
import { ResearchError, normalizeText, terms } from './text.js';

// research.extract: an extraction table. Given columns (what to pull out of
// each paper), one row per paper whose cells each carry the value, the
// excerpt and page that support it, and the exact words quoted from it. The
// model only reads; every cell it fills is checked against the excerpt it
// names before it is kept, so a value with no verbatim support is left empty
// and marked unsupported, never guessed.

const MAX_COLUMNS = 8;
const CANDIDATES_PER_COLUMN = 3;
const MAX_OFFERED = 8;
const EXCERPT_CHARS = 1200;
const VALUE_CHARS = 200;
const ROW_MAX_TOKENS = 700;

function readColumns(input) {
  const raw = input?.columns;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_COLUMNS) {
    throw new ResearchError('invalid_input', `columns must be a list of 1 to ${MAX_COLUMNS} column names or { name, question } objects`);
  }
  const columns = raw.map((column) => {
    const name = typeof column === 'string' ? column : column?.name;
    const question = typeof column === 'object' && typeof column?.question === 'string' ? column.question.slice(0, 300) : null;
    if (typeof name !== 'string' || !name.trim() || name.length > 60) throw new ResearchError('invalid_input', 'every column needs a name of at most 60 characters');
    return { name: name.trim(), question };
  });
  if (new Set(columns.map((c) => c.name.toLowerCase())).size !== columns.length) throw new ResearchError('invalid_input', 'column names must be unique');
  return columns;
}

// The excerpts of one paper most likely to answer each column, at most
// MAX_OFFERED in all, labelled E1, E2, … for the model.
function offerExcerpts(excerpts, columns) {
  const chosen = new Map();
  for (const column of columns) {
    const score = scorer(terms(`${column.name} ${column.question ?? ''}`), excerpts.map((excerpt) => excerpt.text));
    excerpts
      .map((excerpt) => ({ excerpt, value: score(excerpt.text).score }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value || a.excerpt.page - b.excerpt.page)
      .slice(0, CANDIDATES_PER_COLUMN)
      .forEach(({ excerpt }) => chosen.set(excerpt.id, excerpt));
  }
  return [...chosen.values()]
    .sort((a, b) => a.page - b.page || a.chunk - b.chunk)
    .slice(0, MAX_OFFERED)
    .map((excerpt, i) => ({ label: `E${i + 1}`, excerpt }));
}

export function rowMessages(paper, columns, offered) {
  return [
    {
      role: 'system',
      content: [
        'You fill one row of a literature extraction table from excerpts of one paper.',
        'Use only the excerpts given. For each column, give the value, the label of the excerpt that supports it, and a quote copied exactly, character for character, from that excerpt that supports the value.',
        'If no excerpt supports a column, give null for it. Never use outside knowledge.',
        'Reply with one JSON object and nothing else: {"cells": {"<column>": {"value": "…", "excerpt": "E1", "quote": "…"} or null}}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Paper: ${paper.title ?? '(untitled)'} (${byline(paper)}) [@${paper.citekey}]`,
        '',
        'Columns:',
        ...columns.map((column) => `- ${column.name}${column.question ? `: ${column.question}` : ''}`),
        '',
        'Excerpts:',
        ...offered.map(({ label, excerpt }) => `${label} (p. ${excerpt.page}): ${clip(excerpt.text, EXCERPT_CHARS)}`),
      ].join('\n'),
    },
  ];
}

// Checks one cell of the model's reply. Kept only if the quote really is in
// the excerpt it names.
export function checkCell(cell, offered) {
  if (cell == null) return { value: null, status: 'not_found' };
  if (typeof cell !== 'object' || Array.isArray(cell)) return { value: null, status: 'unsupported', reason: 'the cell is not an object' };
  const value = typeof cell.value === 'number' && Number.isFinite(cell.value) ? String(cell.value) : typeof cell.value === 'string' ? cell.value.trim() : '';
  if (!value) return { value: null, status: 'not_found' };
  const label = typeof cell.excerpt === 'string' ? cell.excerpt.trim().toUpperCase() : '';
  const entry = offered.find((candidate) => candidate.label === label);
  if (!entry) return { value: null, status: 'unsupported', reason: `names no offered excerpt (${label || 'none'})` };
  const quote = typeof cell.quote === 'string' ? normalizeText(cell.quote).replace(/^["']|["']$/g, '') : '';
  if (quote.split(' ').length < 2) return { value: null, status: 'unsupported', reason: 'no supporting quote' };
  if (!normalizeText(entry.excerpt.text).includes(quote)) return { value: null, status: 'unsupported', reason: `the quote is not in ${label}` };
  return { value: value.slice(0, VALUE_CHARS), status: 'supported', excerptId: entry.excerpt.id, page: entry.excerpt.page, quote };
}

function table(columns, rows) {
  const esc = (text) => String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  const lines = [`| Paper | ${columns.map((c) => esc(c.name)).join(' | ')} |`, `|---|${columns.map(() => '---').join('|')}|`];
  for (const row of rows) {
    const cells = columns.map((column) => {
      const cell = row.cells[column.name];
      return cell.status === 'supported' ? `${esc(cell.value)} (p. ${cell.page})` : '—';
    });
    lines.push(`| ${esc(row.title ?? '(untitled)')} [@${row.citekey}] | ${cells.join(' | ')} |`);
  }
  const evidence = rows.flatMap((row) =>
    columns
      .map((column) => ({ column, cell: row.cells[column.name] }))
      // A quote that itself holds a double quote cannot be written as a
      // quotation here; it is still in the structured output and checked.
      .filter(({ cell }) => cell.status === 'supported' && !cell.quote.includes('"'))
      .map(({ column, cell }) => `- ${esc(column.name)}, @${row.citekey}: "${cell.quote}" [@${row.citekey}, p. ${cell.page}]`)
  );
  return [...lines, '', 'Evidence:', ...(evidence.length > 0 ? evidence : ['- (no supported cells)'])].join('\n');
}

export async function extract(input, ctx) {
  const columns = readColumns(input);
  const maxPapers = optionalInt(input, 'maxPapers', { min: 1, max: 10, fallback: 5 });
  const projects = scopeFor(ctx, input);
  const refs = optionalRefs(input, 'papers', { max: 10 });
  if (!refs && input?.question == null) throw new ResearchError('invalid_input', 'name the papers, or give a question to find them by');

  let papers;
  if (refs) {
    papers = await resolveRefs(ctx, projects, refs);
  } else {
    const question = requireText(input, 'question');
    const words = terms(`${question} ${columns.map((c) => `${c.name} ${c.question ?? ''}`).join(' ')}`);
    if (words.length === 0) throw new ResearchError('invalid_input', 'the question has no words to search for');
    papers = (await rankPapers(ctx, { projects, words, maxPapers, excerptsPerPaper: 1 })).map((entry) => entry.paper);
  }
  papers = papers.slice(0, maxPapers);

  // Every excerpt that could reach the model is known before the first call,
  // so a private library is refused before anything is sent.
  const plans = [];
  for (const paper of papers) {
    const excerpts = await excerptsOf({ ownerId: ctx.ownerId, paperId: paper.id });
    plans.push({ paper, offered: offerExcerpts(excerpts, columns) });
  }
  assertModelMayRead(ctx, plans.flatMap((plan) => plan.offered.map((entry) => entry.excerpt)));

  const rows = [];
  const touched = new Set();
  for (const { paper, offered } of plans) {
    touched.add(paper.id);
    const cells = {};
    if (offered.length === 0) {
      for (const column of columns) cells[column.name] = { value: null, status: 'not_found', reason: 'no excerpt of this paper matches the column' };
    } else {
      offered.forEach((entry) => touched.add(entry.excerpt.id));
      const reply = await complete(ctx.model, { messages: rowMessages(paper, columns, offered), maxTokens: ROW_MAX_TOKENS, signal: ctx.signal });
      let parsed = null;
      try {
        parsed = JSON.parse(extractJsonObject(reply) ?? 'null');
      } catch {
        parsed = null;
      }
      const replyCells = parsed && typeof parsed.cells === 'object' && parsed.cells ? parsed.cells : null;
      for (const column of columns) {
        if (!replyCells) {
          cells[column.name] = { value: null, status: 'unsupported', reason: 'the model reply was not the JSON asked for' };
          continue;
        }
        const key = Object.keys(replyCells).find((name) => name.trim().toLowerCase() === column.name.toLowerCase());
        cells[column.name] = checkCell(key === undefined ? null : replyCells[key], offered);
      }
    }
    rows.push({ paperId: paper.id, citekey: paper.citekey, title: paper.title, year: paper.year, cells });
  }

  const quotes = rows.flatMap((row) =>
    Object.values(row.cells)
      .filter((cell) => cell.status === 'supported')
      .map((cell) => ({ text: cell.quote, excerptId: cell.excerptId, citekey: row.citekey, page: cell.page }))
  );
  const supported = quotes.length;
  return {
    output: { columns: columns.map((c) => c.name), rows, quotes, citations: rows.map((row) => ({ citekey: row.citekey })), supported, cells: rows.length * columns.length },
    touchedNodeIds: [...touched],
    artifacts: [{ name: `Extraction table: ${columns.map((c) => c.name).join(', ')}`, content: table(columns, rows) }],
  };
}
