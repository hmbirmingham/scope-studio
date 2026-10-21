import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ingestLibrary } from '../../plugins/research/ingest.js';
import { createPdfText } from '../../plugins/research/pdf.js';
import { findPapers } from '../../plugins/research/store.js';
import { findCitations, findDois } from '../../plugins/research/text.js';
import { fixturePath } from './catalog.js';

// What a research task needs beyond a code task: its paper set ingested into
// the graph for the arm's project, and an objective check of the answer
// against the task's key. Like a code task's tests, the check never asks a
// model: the answer must name the method, cite its paper with the library's
// citekey and name the table, and every citation in it must resolve to a
// paper ingested for that arm.

const noEmbed = async (texts) => texts.map(() => null);

// The fixture's PDFs read with pdftotext when it is installed, otherwise
// from the output recorded next to them, so the benchmark measures the agent
// and not whether poppler is on the machine.
async function pdfReader(dir) {
  const real = createPdfText();
  if ((await real.status()).available) return real;
  const recorded = {};
  for (const file of readdirSync(join(dir, 'pdftotext'))) {
    recorded[join(dir, 'pdfs', file.replace(/\.txt$/, '.pdf'))] = join(dir, 'pdftotext', file);
  }
  return createPdfText({ recorded });
}

export async function prepareLibrary(task, { ownerId, project, db, embed = false }) {
  const dir = fixturePath(task);
  const library = join(dir, 'library.json');
  if (!existsSync(library)) throw new Error(`fixture ${task.fixture} has no library.json`);
  // The papers are invented and openly licensed, so the library may be sent
  // to the cloud like any public material; that keeps the local+cloud arm's
  // routing the same as on a code task.
  return ingestLibrary({ ownerId, path: library, project, privacy: 'cloud', pdf: await pdfReader(dir), embed: embed ? undefined : noEmbed, db });
}

function mentions(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

export async function answerCheck(task, { answer, ownerId, project, db }) {
  const text = typeof answer === 'string' ? answer : '';
  const { method, citekey, table } = task.check;
  const cited = [...new Set(findCitations(text).map((cite) => cite.citekey))];
  const problems = [];
  if (!text.trim()) problems.push('there is no answer');
  if (text.trim() && !mentions(text, method)) problems.push(`it does not name ${method}`);
  if (text.trim() && !cited.some((key) => key.toLowerCase() === citekey.toLowerCase())) problems.push(`it does not cite [@${citekey}]`);
  if (text.trim() && !mentions(text, table)) problems.push(`it does not name ${table}`);

  const dois = findDois(text);
  if (cited.length + dois.length > 0) {
    const papers = await findPapers({ ownerId, projects: [project], citekeys: cited, dois, db });
    const keys = new Set(papers.map((paper) => paper.citekey.toLowerCase()));
    const known = new Set(papers.map((paper) => paper.doi));
    const unresolved = [...cited.filter((key) => !keys.has(key.toLowerCase())).map((key) => `@${key}`), ...dois.filter((doi) => !known.has(doi))];
    if (unresolved.length > 0) problems.push(`citations that resolve to no ingested paper: ${unresolved.join(', ')}`);
  }
  return {
    completed: problems.length === 0,
    exitCode: null,
    timedOut: false,
    testsTampered: false,
    output: problems.length === 0 ? `the answer names ${method}, cites [@${citekey}] and ${table}, and every citation resolves` : `not completed: ${problems.join('; ')}`,
  };
}
