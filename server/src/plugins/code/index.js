import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createScratchSandbox, removeSandbox, sandboxGit } from '../../workspace/sandbox/checkout.js';
import { CodeError, checkoutRoot, resolveInside } from './paths.js';
import { defaultSandbox, projectScripts, runDeclaredScript } from './scripts.js';

// The code vertical (docs/architecture/agent-workspace.md, "Plug-in
// capability contract"). Reading and searching work in the run's sandbox copy
// or, without one, the user's checkout; edits and generated code happen only
// in the sandbox copy; scripts are only those the project declares.

const MAX_RESULTS = 200;
const DEFAULT_RESULTS = 50;
const MAX_MATCH_TEXT = 300;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_READ_CHARS = 64 * 1024;
const DEFAULT_READ_LINES = 400;
const MAX_READ_LINES = 2_000;
const MAX_EDIT_CHARS = 512 * 1024;
const MAX_DIFF_CHARS = 20_000;
const MAX_GENERATED_CHARS = 200 * 1024;
const MAX_GENERATED_TIMEOUT_MS = 120_000;

const GIT_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

function requireString(input, key, { allowEmpty = false, max = MAX_EDIT_CHARS } = {}) {
  const value = input?.[key];
  if (typeof value !== 'string' || (!allowEmpty && value === '') || value.length > max) {
    throw new CodeError('invalid_input', `${key} must be a ${allowEmpty ? '' : 'non-empty '}string of at most ${max} characters`);
  }
  return value;
}

function optionalInt(input, key, { min, max, fallback }) {
  const value = input?.[key];
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new CodeError('invalid_input', `${key} must be an integer from ${min} to ${max}`);
  return value;
}

// git in the user's checkout or the sandbox copy. In the sandbox the git
// directory is always named explicitly (see workspace/sandbox/checkout.js).
function checkoutGit(ctx, root, args) {
  if (ctx.sandbox?.worktree) return sandboxGit(ctx.sandbox, args, { maxBuffer: 8 * 1024 * 1024 });
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...GIT_FLAGS, ...args], { cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: 60_000, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err) {
        const failure = new CodeError('git_failed', String(stderr || err.message).trim().slice(0, 500));
        failure.exitCode = typeof err.code === 'number' ? err.code : null;
        failure.stdout = stdout;
        reject(failure);
      } else resolvePromise(stdout);
    });
  });
}

async function isGitCheckout(ctx, root) {
  if (ctx.sandbox?.worktree) return true;
  try {
    await checkoutGit(ctx, root, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

async function search(input, ctx) {
  const query = requireString(input, 'query', { max: 500 });
  const maxResults = optionalInt(input, 'maxResults', { min: 1, max: MAX_RESULTS, fallback: DEFAULT_RESULTS });
  const root = checkoutRoot(ctx);
  const pathspec = input.path == null || input.path === '.' ? [] : [resolveInside(root, input.path).rel];

  const tracked = await isGitCheckout(ctx, root);
  // --literal-pathspecs: a path is a path, never pathspec magic such as
  // ':(top)'; -e: a query that starts with '-' is a pattern, not an option.
  const args = ['--literal-pathspecs', 'grep', '-n', '-z', '-I', '--no-color', input.regex === true ? '-E' : '-F'];
  if (!tracked) args.splice(2, 0, '--no-index');
  if (input.ignoreCase === true) args.push('-i');
  args.push('-e', query, '--', ...pathspec);

  let stdout = '';
  try {
    stdout = await checkoutGit(ctx, root, args);
  } catch (err) {
    // git grep exits 1 when nothing matches; anything else is a real failure.
    if (err.exitCode !== 1) throw new CodeError('search_failed', err.message);
  }

  const matches = [];
  let total = 0;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [path, lineNo, ...rest] = line.split('\0');
    total += 1;
    if (matches.length < maxResults) {
      const text = rest.join('\0');
      matches.push({ path, line: Number(lineNo), text: text.length > MAX_MATCH_TEXT ? `${text.slice(0, MAX_MATCH_TEXT)}…` : text });
    }
  }
  return { output: { query, matches, total, truncated: total > matches.length } };
}

async function readText(abs, rel) {
  const stat = await lstat(abs).catch(() => null);
  if (!stat) throw new CodeError('not_found', `${rel} does not exist`);
  if (!stat.isFile()) throw new CodeError('not_a_file', `${rel} is not a regular file`);
  if (stat.size > MAX_FILE_BYTES) throw new CodeError('file_too_large', `${rel} is larger than ${MAX_FILE_BYTES} bytes`);
  const buffer = await readFile(abs);
  if (buffer.subarray(0, 8192).includes(0)) throw new CodeError('binary_file', `${rel} is a binary file`);
  return buffer.toString('utf8');
}

async function read(input, ctx) {
  const root = checkoutRoot(ctx);
  const { abs, rel } = resolveInside(root, input?.path);
  const startLine = optionalInt(input, 'startLine', { min: 1, max: 10_000_000, fallback: 1 });
  const maxLines = optionalInt(input, 'maxLines', { min: 1, max: MAX_READ_LINES, fallback: DEFAULT_READ_LINES });

  const lines = (await readText(abs, rel)).split('\n');
  const slice = lines.slice(startLine - 1, startLine - 1 + maxLines);
  let content = slice.join('\n');
  let truncated = startLine - 1 + slice.length < lines.length;
  if (content.length > MAX_READ_CHARS) {
    content = content.slice(0, MAX_READ_CHARS);
    truncated = true;
  }
  const endLine = startLine - 1 + content.split('\n').length;
  return { output: { path: rel, startLine, endLine: Math.min(endLine, lines.length), totalLines: lines.length, truncated, content } };
}

function countOccurrences(text, search) {
  let count = 0;
  for (let at = text.indexOf(search); at !== -1; at = text.indexOf(search, at + search.length)) count += 1;
  return count;
}

// Opens without following a final symlink, so a link planted after the path
// check still cannot redirect the write.
async function writeNoFollow(abs, content, { create }) {
  const flags = constants.O_WRONLY | constants.O_NOFOLLOW | (create ? constants.O_CREAT | constants.O_EXCL : constants.O_TRUNC);
  const handle = await open(abs, flags, 0o644);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}

async function edit(input, ctx) {
  const root = checkoutRoot(ctx, { sandboxOnly: true });
  const { abs, rel } = resolveInside(root, input?.path);
  const searchText = requireString(input, 'search', { allowEmpty: true });
  const replace = requireString(input, 'replace', { allowEmpty: true });

  const exists = Boolean(await lstat(abs).catch(() => null));
  let created = false;
  if (!exists) {
    // An empty SEARCH on a missing file creates it; anything else is a
    // mistake about the file's current state.
    if (searchText !== '') throw new CodeError('not_found', `${rel} does not exist`);
    await mkdir(dirname(abs), { recursive: true });
    // The parent may have been created through a symlink race; check again.
    resolveInside(root, rel);
    await writeNoFollow(abs, replace, { create: true });
    created = true;
  } else {
    if (searchText === '') throw new CodeError('search_required', `${rel} exists, so the edit needs a SEARCH block that matches it`);
    const current = await readText(abs, rel);
    const count = countOccurrences(current, searchText);
    if (count === 0) throw new CodeError('search_not_found', `the SEARCH block does not match ${rel}`);
    if (count > 1) throw new CodeError('search_ambiguous', `the SEARCH block matches ${rel} ${count} times; include more context`, { matches: count });
    const at = current.indexOf(searchText);
    await writeNoFollow(abs, current.slice(0, at) + replace + current.slice(at + searchText.length), { create: false });
  }

  if (created) await sandboxGit(ctx.sandbox, ['--literal-pathspecs', 'add', '--intent-to-add', '--', rel]);
  let diff = await sandboxGit(ctx.sandbox, ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--', rel]);
  if (diff.length > MAX_DIFF_CHARS) diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n… diff truncated`;
  return {
    output: { path: rel, created, diff },
    artifacts: [{ kind: 'diff', path: rel, content: diff }],
  };
}

async function runScript(input, ctx, sandbox) {
  const script = requireString(input, 'script', { max: 100 });
  return { output: await runDeclaredScript(ctx, script, sandbox) };
}

const LANGUAGES = {
  node: { command: 'node', extension: 'mjs' },
  python: { command: 'python3', extension: 'py' },
};

async function runGenerated(input, ctx, sandboxRunner) {
  const language = LANGUAGES[input?.language];
  if (!language) throw new CodeError('invalid_input', `language must be one of ${Object.keys(LANGUAGES).join(', ')}`);
  const code = requireString(input, 'code', { max: MAX_GENERATED_CHARS });
  const timeoutMs = optionalInt(input, 'timeoutMs', { min: 100, max: MAX_GENERATED_TIMEOUT_MS, fallback: 30_000 });

  // A run without a sandbox copy still gets a private scratch directory,
  // removed as soon as the code has run.
  const sandbox = ctx.sandbox?.scratch ? ctx.sandbox : await createScratchSandbox();
  const own = sandbox !== ctx.sandbox;
  const file = join(sandbox.scratch, `generated-${randomUUID()}.${language.extension}`);
  try {
    await writeFile(file, code, { mode: 0o644 });
    const result = await sandboxRunner.run({
      command: language.command,
      args: [file],
      cwd: sandbox.scratch,
      writable: [sandbox.scratch],
      // The project copy is readable, so generated code can analyse it, but
      // only scripts and edits change it.
      readOnly: sandbox.worktree ? [sandbox.worktree] : [],
      protect: ctx.localPath ? [ctx.localPath] : [],
      timeoutMs,
      memoryMb: 512,
      cpuSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
      signal: ctx.signal,
    });
    return {
      output: {
        language: input.language,
        ok: result.ok,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        limit: result.limit,
        durationMs: result.durationMs,
        output: result.output,
        truncated: result.truncated,
      },
    };
  } finally {
    if (own) await removeSandbox(sandbox).catch(() => {});
    else await rm(file, { force: true }).catch(() => {});
  }
}

// A verifier runs the project's own script for that check. A project that
// declares none is not failed for it: the result says the check is
// unavailable, so the step is verified by what the project does have.
function scriptVerifier(name, scripts, sandbox) {
  return {
    name: `code.${name}`,
    tags: ['code'],
    async verify(_result, ctx) {
      let root;
      try {
        root = checkoutRoot(ctx);
      } catch {
        return { ok: true, unavailable: true, detail: 'no checkout to verify' };
      }
      const declared = await projectScripts(root);
      const script = scripts.find((candidate) => declared.includes(candidate));
      if (!script) return { ok: true, unavailable: true, detail: `the project declares no ${scripts.map((s) => `"${s}"`).join(' or ')} script` };
      let run;
      try {
        run = await runDeclaredScript(ctx, script, sandbox);
      } catch (err) {
        // A sandbox copy with no OS sandbox cannot be checked safely. That is
        // not a pass: the step stays unverified and is not written back.
        if (err.code !== 'sandbox_unavailable') throw err;
        return { ok: false, unverified: true, detail: `npm run ${script} was not run: ${err.message}`, script, sandboxed: false };
      }
      const tail = run.output.length > 2_000 ? `…${run.output.slice(-2_000)}` : run.output;
      const status = run.ok ? 'passed' : run.timedOut ? 'timed out' : `failed (exit ${run.exitCode})`;
      return { ok: run.ok, detail: `npm run ${script} ${status}${tail ? `\n${tail}` : ''}`, script, sandboxed: run.sandboxed };
    },
  };
}

const EDIT_VERIFIERS = ['code.typecheck', 'code.lint', 'code.build', 'code.tests'];

// The plug-in, built around the OS sandbox it runs model-written code in.
// The registry uses the default; tests pass a runner from
// createSandboxRunner to exercise a machine without a sandbox.
export function createCodePlugin({ sandbox = defaultSandbox } = {}) {
  return {
    name: 'code',
    capabilities: [
      {
        name: 'code.search',
        tags: ['code'],
        permission: 'read_graph',
        input: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'Text to find (a fixed string unless regex is true).' },
            path: { type: 'string', description: 'Limit the search to this file or directory, relative to the project.' },
            regex: { type: 'boolean' },
            ignoreCase: { type: 'boolean' },
            maxResults: { type: 'integer', minimum: 1, maximum: MAX_RESULTS },
          },
        },
        verifiers: [],
        run: search,
      },
      {
        name: 'code.read',
        tags: ['code'],
        permission: 'read_graph',
        input: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string' },
            startLine: { type: 'integer', minimum: 1 },
            maxLines: { type: 'integer', minimum: 1, maximum: MAX_READ_LINES },
          },
        },
        verifiers: [],
        run: read,
      },
      {
        name: 'code.edit',
        tags: ['code'],
        permission: 'edit_files',
        writesCode: true,
        input: {
          type: 'object',
          required: ['path', 'search', 'replace'],
          properties: {
            path: { type: 'string' },
            search: { type: 'string', description: 'Exact text that occurs exactly once in the file; empty only to create a new file.' },
            replace: { type: 'string' },
          },
        },
        verifiers: EDIT_VERIFIERS,
        run: edit,
      },
      {
        name: 'code.run_script',
        tags: ['scripts'],
        permission: 'run_scripts',
        input: { type: 'object', required: ['script'], properties: { script: { type: 'string', description: 'A script the project declares in package.json.' } } },
        verifiers: [],
        run: (input, ctx) => runScript(input, ctx, sandbox),
      },
      {
        name: 'code.run_generated',
        tags: ['sandbox'],
        permission: 'run_generated_code',
        writesCode: true,
        input: {
          type: 'object',
          required: ['language', 'code'],
          properties: {
            language: { type: 'string', enum: Object.keys(LANGUAGES) },
            code: { type: 'string' },
            timeoutMs: { type: 'integer', minimum: 100, maximum: MAX_GENERATED_TIMEOUT_MS },
          },
        },
        verifiers: [],
        run: (input, ctx) => runGenerated(input, ctx, sandbox),
      },
    ],
    verifiers: [
      scriptVerifier('tests', ['test'], sandbox),
      scriptVerifier('build', ['build'], sandbox),
      scriptVerifier('typecheck', ['typecheck', 'type-check', 'tsc'], sandbox),
      scriptVerifier('lint', ['lint'], sandbox),
    ],
  };
}

export default createCodePlugin();
