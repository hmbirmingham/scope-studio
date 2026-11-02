import { readFile } from 'node:fs/promises';
import { knownChecks } from '../eval/check.js';
import { loadRubric } from '../eval/rubric.js';
import { agentPath, parseFrontmatter } from './vault.js';

// A task is a markdown file, because the vault is a format and not a tool: the
// thing that defines the work is the same kind of file as the thing that
// records it, and both are readable without this CLI.
//
//   ---
//   id: rag-eval-brief
//   use_case: research-brief
//   important: true
//   attempts: 3
//   ---
//   ## Task
//   What are the standard ways people evaluate RAG retrieval quality?
//
//   ## Gates
//   - cited: every_paragraph_matches \[\d+\]
//   - length: max_words 400
//   - no-filler: no_placeholder

// Split on level-2 headings rather than regex lookahead: a trailing section has
// no following heading to anchor against, and JS has no \Z.
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

function section(body, name) {
  const found = sections(body).get(name.toLowerCase());
  return found ? found : null;
}

// "- id: check arg" — the arg is the rest of the line so a regex can contain
// spaces without quoting.
export function parseGates(text) {
  if (!text) return [];
  const gates = [];
  for (const line of text.split('\n')) {
    const m = /^\s*-\s*([A-Za-z0-9_-]+)\s*:\s*([a-z_]+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, id, check, rawArg] = m;
    const arg = rawArg.trim();
    gates.push({
      id,
      check,
      arg: arg === '' ? undefined : /^-?\d+(\.\d+)?$/.test(arg) ? Number(arg) : arg,
    });
  }
  return gates;
}

/**
 * @param {string} text the task file
 * @param {string} source its path, for error messages
 * @param {object|null} rubric the loaded rubric for this task's use_case, if any
 */
export function parseTask(text, source, rubric = null) {
  const { fields, body } = parseFrontmatter(text);
  const prompt = section(body, 'Task') ?? section(body, 'Question');
  if (!prompt) throw new Error(`${source}: needs a "## Task" or "## Question" section`);

  // The rubric's gates apply to every task of that use case; the task's own
  // gates are added, and one sharing an id overrides the rubric's so a task can
  // tighten a limit without restating the rest.
  const own = parseGates(section(body, 'Gates'));
  const fromRubric = rubric ? parseGates(rubric.gatesText) : [];
  const overridden = new Set(own.map((g) => g.id));
  const gates = [...fromRubric.filter((g) => !overridden.has(g.id)), ...own];
  // The rule, enforced at load time rather than discovered at run time.
  if (gates.length === 0) {
    throw new Error(
      `${source}: no gates. A step nobody can check is a question for you, not a task — add a "## Gates" section.`
    );
  }
  const unknown = gates.filter((g) => !knownChecks().includes(g.check));
  if (unknown.length) {
    throw new Error(
      `${source}: unknown check${unknown.length > 1 ? 's' : ''} ${unknown.map((g) => g.check).join(', ')}. Known: ${knownChecks().join(', ')}`
    );
  }

  // Vault-relative paths whose contents are the material the task works from.
  // This is a deliberately small stand-in for retrieval: when the graph lands,
  // it replaces how sources are chosen, not what a task does with them.
  const sources = (section(body, 'Sources') ?? '')
    .split('\n')
    .map((line) => /^\s*-\s+(.*)$/.exec(line)?.[1]?.trim())
    .filter(Boolean);

  // A task may fetch its own material instead of reading the vault. The two are
  // deliberately the same shape downstream: by the time gates run, source text
  // is source text and nothing cares where it came from.
  const searchQueries = (section(body, 'Search') ?? '')
    .split('\n')
    .map((line) => /^\s*-\s+(.*)$/.exec(line)?.[1]?.trim())
    .filter(Boolean);

  return {
    searchQueries,
    id: fields.id ?? source.replace(/\.md$/, ''),
    useCase: fields.use_case ?? null,
    important: fields.important === true || Boolean(rubric?.important),
    attempts: Number.isInteger(fields.attempts) ? fields.attempts : 2,
    prompt,
    gates,
    sources,
    instructions: rubric?.instructions ?? null,
    rubricLines: rubric?.lines ?? [],
    rubricSource: rubric?.source ?? null,
    source,
  };
}

/** Load a task by id from the vault, or from an explicit path. */
export async function loadTask(config, idOrPath) {
  const isPath = idOrPath.includes('/') || idOrPath.endsWith('.md');
  const file = isPath ? idOrPath : agentPath(config, 'tasks', `${idOrPath}.md`);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`no task at ${file}`);
    throw err;
  }
  // The use_case has to be read before the task can be fully parsed, since the
  // rubric supplies gates the task is allowed to override.
  const { fields } = parseFrontmatter(text);
  const rubric = fields.use_case ? await loadRubric(fields.use_case) : null;
  return parseTask(text, file, rubric);
}
