import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// An action opens something on the user's screen through macOS's own `open`
// command: a web search or page in their browser, an app, or a project file in
// a text editor. Like a run, it is never arbitrary: the model names what to
// open, each kind is checked against a narrow rule, the user approves it, and
// it executes with a fixed argument list and no shell. Nothing leaves the
// machine to do it — no screenshots, no model watching the screen.

const MAX_ACTIONS = 100;
const TTL_MS = 2 * 60 * 60 * 1000;
const OPEN_TIMEOUT_MS = 10_000;

export const ACTION_KINDS = ['search', 'url', 'app', 'file'];
const ACTION_BLOCK = /<open\s+kind="(search|url|app|file)"\s*>([\s\S]*?)<\/open>/g;

// Private by default: the search engine sees the query, nothing else.
export const SEARCH_URL = 'https://duckduckgo.com/?q=';
const MAX_QUERY = 200;
const MAX_URL = 2048;

// Opening these would hand an action a way to run commands, which is exactly
// what actions exist not to do.
const DENIED_APPS = new Set(['terminal', 'iterm', 'iterm2', 'script editor', 'automator', 'shortcuts', 'console']);
const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9 .&+'-]{0,59}$/;

const actions = new Map();

export function parseActions(answer) {
  const found = [];
  for (const [, kind, body] of answer.matchAll(ACTION_BLOCK)) {
    const target = body.trim();
    if (target && !found.some((a) => a.kind === kind && a.target === target)) found.push({ kind, target });
  }
  return found;
}

// Returns { args, label } for `open`, or { problem } saying why it will not run.
// File checks touch the disk, so this is async.
export async function planAction({ kind, target }, { localPath } = {}) {
  if (kind === 'search') {
    const query = target.replace(/\s+/g, ' ').trim();
    if (!query || query.length > MAX_QUERY) return { problem: `a search must be 1–${MAX_QUERY} characters` };
    const url = SEARCH_URL + encodeURIComponent(query);
    return { args: ['-u', url], label: `Search the web for “${query}”`, url };
  }

  if (kind === 'url') {
    let url;
    try {
      url = new URL(target);
    } catch {
      return { problem: 'not a web address' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { problem: 'only http and https addresses open' };
    if (url.username || url.password) return { problem: 'addresses carrying a login are not opened' };
    if (url.href.length > MAX_URL) return { problem: 'that address is too long' };
    return { args: ['-u', url.href], label: `Open ${url.host}`, url: url.href };
  }

  if (kind === 'app') {
    const name = target.replace(/\.app$/i, '').trim();
    if (!APP_NAME.test(name)) return { problem: 'not an app name' };
    if (DENIED_APPS.has(name.toLowerCase())) return { problem: `${name} can run commands, so actions do not open it` };
    return { args: ['-a', name], label: `Open ${name}` };
  }

  if (kind === 'file') {
    if (!localPath) return { problem: 'this project has no working copy to open files from' };
    if (isAbsolute(target)) return { problem: 'give the path inside the project, not an absolute one' };
    let root;
    let file;
    try {
      root = await realpath(localPath);
      file = await realpath(resolve(root, target));
    } catch {
      return { problem: `${target} is not in this project's working copy` };
    }
    // Resolved through symlinks, so a link pointing outside the folder is refused too.
    const rel = relative(root, file);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
      return { problem: 'files outside the project folder are not opened' };
    }
    const info = await stat(file);
    if (!info.isFile()) return { problem: `${target} is not a file` };
    // -t opens in a text editor. A plain `open` would execute a .command or
    // launch a bundled app; this only ever shows the text.
    return { args: ['-t', file], label: `Open ${rel} in a text editor`, path: file };
  }

  return { problem: `unknown action kind: ${kind}` };
}

function prune() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, action] of actions) {
    if (action.createdAt < cutoff) actions.delete(id);
  }
  while (actions.size > MAX_ACTIONS) actions.delete(actions.keys().next().value);
}

export async function recordActions({ ownerId, conversationId, project, localPath, found, platform = process.platform }) {
  const recorded = [];
  for (const item of found) {
    const plan = platform === 'darwin' ? await planAction(item, { localPath }) : { problem: 'opening things on screen needs macOS' };
    const action = {
      id: randomUUID(),
      ownerId,
      conversationId,
      project: project ?? null,
      kind: item.kind,
      target: item.target,
      label: plan.label ?? item.target,
      args: plan.args ?? null,
      state: plan.problem ? 'refused' : 'proposed',
      problem: plan.problem ?? null,
      error: null,
      createdAt: Date.now(),
    };
    actions.set(action.id, action);
    recorded.push(action);
  }
  prune();
  return recorded;
}

export function getAction(ownerId, id) {
  const action = actions.get(id);
  return action && action.ownerId === ownerId ? action : null;
}

export function listActions(ownerId, { conversationId } = {}) {
  return [...actions.values()].filter(
    (a) => a.ownerId === ownerId && (!conversationId || a.conversationId === conversationId)
  );
}

export function presentAction(action) {
  return {
    id: action.id,
    kind: action.kind,
    target: action.target,
    label: action.label,
    project: action.project,
    state: action.state,
    problem: action.problem,
    error: action.error,
    auto: Boolean(action.auto),
  };
}

// execFile, not a shell; `run` is injectable so tests never open anything.
export function executeAction(action, { run = execFile } = {}) {
  return new Promise((resolveDone) => {
    run('open', action.args, { timeout: OPEN_TIMEOUT_MS }, (err, _stdout, stderr) => {
      resolveDone(err ? { ok: false, error: (stderr || err.message).trim() } : { ok: true });
    });
  });
}

// Display mode: the user has agreed, once, that actions may open without a
// card each time. Every rule still applies, and one more: a web address opens
// by itself only if the answer's web search cited it. An address the model
// produced on its own could come from a page it read, so it still asks.
export function autoOpens(action, { citedUrls = [] } = {}) {
  if (action.state !== 'proposed') return false;
  if (action.kind !== 'url') return true;
  const cited = new Set(citedUrls.map((url) => new URL(url).href));
  return cited.has(new URL(action.target).href);
}

export async function openNow(action, { run } = {}) {
  action.state = 'opening';
  const result = await executeAction(action, { run });
  Object.assign(action, result.ok ? { state: 'opened', auto: true } : { state: 'failed', error: result.error });
  return action;
}

export function resetActions() {
  actions.clear();
}
