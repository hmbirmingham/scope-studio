import { tryEmbedDocuments } from '../../lib/embeddings.js';
import {
  ensureRelationship,
  pruneChunkedNodes,
  upsertNodeByExternalId,
} from '../../models/nodeStore.js';

export const DEFAULT_LIMITS = {
  maxFilesPerRepo: 200,
  maxChunksPerRepo: 400,
  maxFileBytes: 128 * 1024,
};
export const CHUNK_CHARS = 3000;
export const CHUNK_OVERLAP_CHARS = 200;
// A whitespace-free line this long is base64, a minified bundle, or a hash —
// never something a question is about, and one of them can eat a whole
// local-tier context budget.
export const DATA_LINE_CHARS = 512;
const FETCH_CONCURRENCY = 8;
const EMBED_BATCH = 32;

const TEXT_EXTENSIONS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'pyi', 'c', 'h', 'cpp', 'cc', 'hpp', 'rs', 'go',
  'java', 'kt', 'kts', 'swift', 'rb', 'php', 'cs', 'm', 'mm', 'sh', 'bash', 'zsh', 'sql', 'r',
  'jl', 'scala', 'lua', 'dart', 'ex', 'exs', 'hs', 'ml', 'clj', 'zig', 'v', 'sv', 'vhd', 'vhdl',
  'md', 'mdx', 'txt', 'rst', 'adoc', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml',
  'html', 'css', 'scss', 'less', 'svg', 'csv', 'tsv', 'ipynb', 'tex', 'bib', 'proto', 'graphql',
  'gradle', 'cmake', 'kicad_sch', 'kicad_pcb', 'kicad_pro', 'sch', 'net', 'env.example',
]);
const TEXT_BASENAMES = new Set([
  'Makefile', 'Dockerfile', 'Rakefile', 'Gemfile', 'Procfile', 'CMakeLists.txt', 'LICENSE',
  'README', 'Justfile', 'Vagrantfile',
]);
const EXCLUDED_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'vendor', '.git', '__pycache__', '.venv',
  'venv', 'coverage', '.next', '.cache', 'site-packages', '.idea', '.vscode', 'bower_components',
]);
const EXCLUDED_BASENAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock',
  'composer.lock', 'Gemfile.lock', 'go.sum', 'flake.lock',
]);
const EXCLUDED_SUFFIXES = ['.min.js', '.min.css', '.map', '.lock', '.snap'];

export function isEligible(entry, limits = DEFAULT_LIMITS) {
  if (entry.type !== 'blob') return false;
  if (!entry.size || entry.size > limits.maxFileBytes) return false;

  const segments = entry.path.split('/');
  const basename = segments.at(-1);
  if (segments.slice(0, -1).some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
  if (EXCLUDED_BASENAMES.has(basename)) return false;
  if (EXCLUDED_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return false;
  if (TEXT_BASENAMES.has(basename)) return true;

  const dot = basename.indexOf('.');
  if (dot <= 0) return false;
  return (
    TEXT_EXTENSIONS.has(basename.slice(dot + 1).toLowerCase()) ||
    TEXT_EXTENSIONS.has(basename.slice(basename.lastIndexOf('.') + 1).toLowerCase())
  );
}

// When a repo exceeds the cap, README and top-level source should win over
// deep test fixtures: shallow first, then alphabetical.
export function prioritize(entries) {
  const depth = (entry) => entry.path.split('/').length;
  return [...entries].sort((a, b) => depth(a) - depth(b) || a.path.localeCompare(b.path));
}

// Line-aligned so a chunk never starts mid-statement; the overlap carries the
// preceding lines forward so a definition split at a boundary is still findable.
export function chunkText(text, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP_CHARS) {
  const chunks = [];
  let current = [];
  let length = 0;

  for (const rawLine of text.split('\n')) {
    if (rawLine.length > DATA_LINE_CHARS && !/\s/.test(rawLine.trim())) continue;
    const line = rawLine.length > size ? rawLine.slice(0, size) : rawLine;
    if (current.length > 0 && length + line.length + 1 > size) {
      chunks.push(current.join('\n'));
      const kept = [];
      let keptLength = 0;
      for (let i = current.length - 1; i >= 0 && keptLength < overlap; i--) {
        kept.unshift(current[i]);
        keptLength += current[i].length + 1;
      }
      current = kept;
      length = keptLength;
    }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

export function chunkExternalId(repoId, index, path) {
  return `${repoId}|${index}|${path}`;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function decodeBlob(data) {
  const buffer = Buffer.from(data.content, 'base64');
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8');
}

export async function ingestRepoFiles({ octokit, repo, repoNode, ownerId, limits = DEFAULT_LIMITS }) {
  const owner = repo.owner.login;
  const name = repo.name;
  const empty = { files: 0, chunks: 0, skipped: 0, pruned: 0, truncated: false };
  if (!repo.default_branch) return empty;

  let tree;
  try {
    tree = await octokit.rest.git.getTree({
      owner,
      repo: name,
      tree_sha: repo.default_branch,
      recursive: 'true',
    });
  } catch (err) {
    if (err.status === 404 || err.status === 409) return empty;
    throw err;
  }

  const eligible = prioritize(tree.data.tree.filter((entry) => isEligible(entry, limits)));
  const selected = eligible.slice(0, limits.maxFilesPerRepo);
  const texts = await mapLimit(selected, FETCH_CONCURRENCY, async (entry) => {
    const blob = await octokit.rest.git.getBlob({ owner, repo: name, file_sha: entry.sha });
    return decodeBlob(blob.data);
  });

  const records = [];
  const chunkCounts = [];
  let budget = limits.maxChunksPerRepo;
  for (let i = 0; i < selected.length && budget > 0; i++) {
    if (texts[i] === null) continue;
    const chunks = chunkText(texts[i]).slice(0, budget);
    if (chunks.length === 0) continue;
    budget -= chunks.length;
    const path = selected[i].path;
    chunkCounts.push({ path, count: chunks.length });
    chunks.forEach((chunk, index) => {
      const heading = chunks.length > 1 ? `${path} (part ${index + 1}/${chunks.length})` : path;
      records.push({ path, index, content: `${heading}\n\n${chunk}` });
    });
  }

  const embeddings = [];
  for (let i = 0; i < records.length; i += EMBED_BATCH) {
    const batch = records.slice(i, i + EMBED_BATCH).map((record) => record.content);
    embeddings.push(...(await tryEmbedDocuments(batch)));
  }

  const nodes = await mapLimit(records, FETCH_CONCURRENCY, (record, i) =>
    upsertNodeByExternalId({
      ownerId,
      type: 'file',
      content: record.content,
      embedding: embeddings[i],
      source: 'github',
      externalId: chunkExternalId(repo.id, record.index, record.path),
      project: repo.full_name,
      privacy: repoNode.privacy,
    })
  );

  const heads = new Map();
  records.forEach((record, i) => {
    if (record.index === 0) heads.set(record.path, nodes[i].id);
  });
  await mapLimit(records, FETCH_CONCURRENCY, (record, i) =>
    ensureRelationship(ownerId, {
      sourceId: nodes[i].id,
      targetId: record.index === 0 ? repoNode.id : heads.get(record.path),
      type: 'part_of',
      weight: 1,
    })
  );

  const pruned = await pruneChunkedNodes(ownerId, 'github', `${repo.id}|`, {
    keepPaths: eligible.map((entry) => entry.path),
    chunkCounts,
  });

  return {
    files: chunkCounts.length,
    chunks: records.length,
    skipped: eligible.length - chunkCounts.length,
    pruned,
    truncated: Boolean(tree.data.truncated),
  };
}
