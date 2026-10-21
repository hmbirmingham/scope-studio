import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Where sandboxes live. They sit in the app's own data directory, never in
// the user's checkout: a sandbox holds model-written changes and generated
// code, and nothing an agent does there should show up as noise (or worse,
// as something to commit) in the repository the user works in.

export class SandboxPathError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// The platform's conventional per-user data directory, so a user who wipes
// application data also wipes old sandboxes.
export function defaultDataDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Scope Studio');
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Scope Studio');
  const xdg = env.XDG_DATA_HOME;
  // The XDG spec says a relative XDG_DATA_HOME is invalid and must be ignored.
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'share'), 'scope-studio');
}

export function dataDir({ env = process.env, ...rest } = {}) {
  const configured = env.SCOPE_DATA_DIR;
  if (configured) {
    if (!isAbsolute(configured)) throw new SandboxPathError('unsafe_sandbox_path', 'SCOPE_DATA_DIR must be an absolute path');
    return resolve(configured);
  }
  return defaultDataDir({ env, ...rest });
}

export function sandboxesDir(options) {
  return join(dataDir(options), 'sandboxes');
}

// Resolves symlinks for as much of the path as exists, so a check made on a
// path that is about to be created still sees through a symlinked parent.
export function realpathLoose(path) {
  const absolute = resolve(path);
  let existing = absolute;
  const missing = [];
  for (;;) {
    try {
      const real = realpathSync(existing);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      missing.push(existing.slice(parent.length).replace(/^[\\/]+/, ''));
      existing = parent;
    }
  }
}

export function isInside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// A sandbox directory must not be inside the user's checkout (or contain it),
// and must never sit under a `.claude` directory, which belongs to another
// tool's configuration and is not ours to write.
export function assertSafeSandboxDir(dir, { repoPath } = {}) {
  const real = realpathLoose(dir);
  for (const candidate of [resolve(dir), real]) {
    if (candidate.split(sep).includes('.claude')) {
      throw new SandboxPathError('unsafe_sandbox_path', 'sandboxes may not be created under a .claude directory');
    }
  }
  if (repoPath) {
    const repo = realpathLoose(repoPath);
    if (isInside(repo, real) || isInside(real, repo)) {
      throw new SandboxPathError('unsafe_sandbox_path', "sandboxes may not be created inside the project's checkout");
    }
  }
  return real;
}
