import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../core/vault.js';

// A rubric is one file with three consumers: the prose becomes the generator's
// system prompt, the gates run as deterministic checks, and the numbered lines
// are the judge's checklist and the retry constraint. Keeping them in one file
// is the point — split them and they drift within a week, and then the thing
// being judged is not the thing being asked for.
//
// Rubrics live in the repo, not the vault: a task is an instance of work, a
// rubric is the versioned standard it is judged against. Changing one should be
// a diff the eval suite reviews.
const RUBRIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'rubrics');

function sections(body) {
  const out = new Map();
  let current = null;
  for (const line of body.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1].toLowerCase();
      out.set(current, []);
      continue;
    }
    if (current) out.get(current).push(line);
  }
  return new Map([...out].map(([k, v]) => [k, v.join('\n').trim()]));
}

/** The numbered lines, as the judge's checklist. */
export function parseRubricLines(text) {
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => /^\s*\d+\.\s+(.*)$/.exec(line)?.[1])
    .filter(Boolean)
    .map((first, i, all) => all[i].trim());
}

export function parseRubric(text, source) {
  const { fields, body } = parseFrontmatter(text);
  const parts = sections(body);
  const instructions = parts.get('instructions');
  if (!instructions) throw new Error(`${source}: a rubric needs an "## Instructions" section`);
  return {
    useCase: fields.use_case ?? null,
    version: fields.version ?? null,
    important: fields.important === true,
    instructions,
    gatesText: parts.get('gates') ?? null,
    lines: parseRubricLines(parts.get('rubric')),
    source,
  };
}

export async function loadRubric(useCase, dir = RUBRIC_DIR) {
  const file = join(dir, `${useCase}.md`);
  try {
    return parseRubric(await readFile(file, 'utf8'), file);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`no rubric for use_case "${useCase}" at ${file}`);
    throw err;
  }
}
