import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isInside, realpathLoose } from '../../workspace/sandbox/paths.js';

// Every path a model names is relative to the checkout it works in and must
// stay there: no absolute paths, no `..`, no symlink that leads out, and
// nothing inside the git directory (whose config decides what git runs).

export class CodeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const MAX_PATH = 1024;

export function checkoutRoot(ctx, { sandboxOnly = false } = {}) {
  const root = ctx?.sandbox?.worktree ?? (sandboxOnly ? null : ctx?.localPath);
  if (!root) {
    throw sandboxOnly
      ? new CodeError('sandbox_required', 'this capability only works in a sandbox copy of the project')
      : new CodeError('no_checkout', 'the project has no local checkout to work in');
  }
  try {
    return realpathSync(root);
  } catch {
    throw new CodeError('no_checkout', 'the project checkout is missing');
  }
}

// Resolves `path` against `root` and returns { abs, rel } for the real
// location, or throws `path_escapes`.
export function resolveInside(root, path) {
  if (typeof path !== 'string' || !path || path.length > MAX_PATH || path.includes('\0')) {
    throw new CodeError('invalid_path', 'a path must be a non-empty relative path');
  }
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path)) throw new CodeError('path_escapes', `${path} is not relative to the project`);
  const segments = path.split(/[\\/]+/);
  if (segments.includes('..')) throw new CodeError('path_escapes', `${path} leaves the project`);
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    throw new CodeError('path_escapes', `${path} is inside the git directory`);
  }

  const lexical = resolve(root, path);
  if (!isInside(root, lexical) || lexical === root) throw new CodeError('path_escapes', `${path} leaves the project`);
  // The real location, after every symlink along the way that exists.
  const real = realpathLoose(lexical);
  if (!isInside(root, real) || real === root) throw new CodeError('path_escapes', `${path} resolves outside the project`);
  const rel = relative(root, real).split(sep).join('/');
  if (rel.split('/').some((segment) => segment.toLowerCase() === '.git')) {
    throw new CodeError('path_escapes', `${path} resolves inside the git directory`);
  }
  return { abs: real, rel };
}
