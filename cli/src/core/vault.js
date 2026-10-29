import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Subdirectories the agent owns. It may read the whole vault and link into any
// note, but it only ever writes inside these.
export const AGENT_DIRS = ['inbox', 'projects', 'meetings', 'research', 'applications', 'tasks', 'runs'];

/**
 * Resolve a path inside the agent's own area, refusing anything that escapes it.
 * The vault holds notes the agent did not write; a traversal bug here would let
 * a model's output overwrite them.
 */
export function agentPath(config, ...segments) {
  const root = resolve(config.vault, config.agentPrefix);
  const target = resolve(root, ...segments);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to write outside ${config.agentPrefix}/: ${segments.join('/')}`);
  }
  return target;
}

export async function vaultExists(config) {
  try {
    await access(config.vault);
    return true;
  } catch {
    return false;
  }
}

/** Is the vault a git repo? That repo is the undo for every agent write. */
export async function vaultIsGit(config) {
  try {
    const { stdout } = await run('git', ['-C', config.vault, 'rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function ensureAgentDirs(config) {
  for (const dir of AGENT_DIRS) {
    await mkdir(agentPath(config, dir), { recursive: true });
  }
}

// Frontmatter here is a deliberate subset: flat keys, string/number/boolean
// scalars and string lists. We both write and read these files, so a subset is
// safe. Reading arbitrary notes from the rest of the vault needs a real YAML
// parser — add the `yaml` package at that point rather than growing this.
function serializeValue(value) {
  if (Array.isArray(value)) return `\n${value.map((v) => `  - ${v}`).join('\n')}`;
  if (typeof value === 'string' && /[:#]|^\s|\s$/.test(value)) return ` ${JSON.stringify(value)}`;
  return ` ${value}`;
}

export function serializeFrontmatter(fields) {
  const body = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}:${serializeValue(v)}`)
    .join('\n');
  return `---\n${body}\n---\n`;
}

export function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields = {};
  let listKey = null;
  for (const line of match[1].split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      fields[listKey].push(item[1].trim());
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, raw] = pair;
    if (raw === '') {
      listKey = key;
      fields[key] = [];
      continue;
    }
    listKey = null;
    if (raw === 'true' || raw === 'false') fields[key] = raw === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(raw)) fields[key] = Number(raw);
    else if (raw.startsWith('"')) {
      try {
        fields[key] = JSON.parse(raw);
      } catch {
        fields[key] = raw;
      }
    } else fields[key] = raw;
  }
  return { fields, body: text.slice(match[0].length) };
}

/** Write a note under the agent's area. Returns the absolute path written. */
export async function writeNote(config, relPath, { fields, body }) {
  const target = agentPath(config, relPath);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, `${serializeFrontmatter(fields)}\n${body.trimEnd()}\n`, 'utf8');
  return target;
}

export async function readNote(config, relPath) {
  return parseFrontmatter(await readFile(agentPath(config, relPath), 'utf8'));
}

/**
 * Commit whatever the agent just wrote. This is the undo that screen tasks and
 * clobbered Obsidian buffers do not otherwise have, so a failure to commit is
 * reported rather than swallowed.
 */
export async function commitVault(config, message) {
  if (!(await vaultIsGit(config))) return { committed: false, reason: 'vault is not a git repo' };
  const prefix = config.agentPrefix;
  // `git add -- <path>` fails on an unmatched pathspec, so a vault the agent has
  // not written to yet is nothing-to-commit rather than an error.
  try {
    await access(resolve(config.vault, prefix));
  } catch {
    return { committed: false, reason: 'nothing to commit' };
  }
  try {
    await run('git', ['-C', config.vault, 'add', '--', prefix]);
    const { stdout } = await run('git', ['-C', config.vault, 'status', '--porcelain', '--', prefix]);
    if (!stdout.trim()) return { committed: false, reason: 'nothing to commit' };
    // -m must precede the `--` separator, or git reads the message as a pathspec.
    await run('git', ['-C', config.vault, 'commit', '--only', '-m', message, '--', prefix]);
    return { committed: true };
  } catch (err) {
    return { committed: false, reason: err.stderr?.trim() || err.message };
  }
}
