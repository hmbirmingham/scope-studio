import { readFile } from 'node:fs/promises';
import { knownChecks } from '../eval/check.js';
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
function parseGates(text) {
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

export function parseTask(text, source) {
  const { fields, body } = parseFrontmatter(text);
  const prompt = section(body, 'Task') ?? section(body, 'Question');
  if (!prompt) throw new Error(`${source}: needs a "## Task" or "## Question" section`);

  const gates = parseGates(section(body, 'Gates'));
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

  return {
    id: fields.id ?? source.replace(/\.md$/, ''),
    useCase: fields.use_case ?? null,
    important: fields.important === true,
    attempts: Number.isInteger(fields.attempts) ? fields.attempts : 2,
    prompt,
    gates,
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
  return parseTask(text, file);
}
