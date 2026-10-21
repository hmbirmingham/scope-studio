// The demo launcher's prerequisite checks (docs/demo.md). Each check returns
// `{ ok, message, fix? }`: `message` says what was found in plain words and
// `fix` is the exact command or step that resolves it. Nothing here installs,
// pulls or starts anything; the launcher prints the fix and stops.
//
// The checks that talk to Postgres or Ollama take their client or fetch as an
// argument, so the tests drive every branch without either.

export const MIN_NODE_MAJOR = 26;
export const EMBED_MODEL = 'nomic-embed-text';

export function checkNode(version = process.versions.node) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return { ok: true, message: `Node ${version}` };
  return {
    ok: false,
    message: `Node ${version} is too old: Scope Studio needs Node ${MIN_NODE_MAJOR} or newer.`,
    fix: 'brew install node   (or: brew upgrade node), then open a new terminal',
  };
}

// The database the demo uses. It is its own database so the demo can never
// touch a development or test database by accident.
export function demoDatabaseUrl(env = process.env) {
  return env.DEMO_DATABASE_URL || 'postgresql://localhost:5432/scope_demo';
}

// The same server's maintenance database, from which the demo database is
// created when it does not exist yet.
export function maintenanceUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

export function databaseName(databaseUrl) {
  return decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
}

// A database name the launcher is willing to put in CREATE DATABASE. Postgres
// cannot take it as a parameter, so it is checked instead.
export function safeDatabaseName(name) {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(name);
}

// Turns a failed Postgres connection into what to do about it.
export function describePostgresError(err, databaseUrl) {
  const where = (() => {
    const url = new URL(databaseUrl);
    return `${url.hostname}:${url.port || 5432}`;
  })();
  if (err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND' || err?.code === 'ETIMEDOUT') {
    return {
      ok: false,
      message: `Postgres is not running at ${where}.`,
      fix: 'brew services start postgresql@18   (first time: brew install postgresql@18 pgvector)',
    };
  }
  if (err?.code === '28000' || err?.code === '28P01') {
    return {
      ok: false,
      message: `Postgres at ${where} refused the login: ${err.message}.`,
      fix: 'Set DEMO_DATABASE_URL to a URL your Postgres accepts, e.g. postgresql://$(whoami)@localhost:5432/scope_demo',
    };
  }
  return { ok: false, message: `Could not use Postgres at ${where}: ${err?.message ?? 'unknown error'}.`, fix: 'Check that Postgres 18 is installed and running: brew services list' };
}

export function checkPgvector(available) {
  if (available) return { ok: true, message: 'pgvector is installed' };
  return {
    ok: false,
    message: 'Postgres is running but the pgvector extension is not installed.',
    fix: 'brew install pgvector && brew services restart postgresql@18',
  };
}

// Ollama resolves an untagged name to `:latest`; match the way it does.
function withTag(name) {
  return name.includes(':') ? name : `${name}:latest`;
}

// Which of the wanted models `/api/tags` does not list, each with the exact
// command that pulls it. The launcher never pulls on its own: a model is
// gigabytes, and the person should choose when to download it.
export function missingModels(tags, wanted) {
  const have = new Set((tags?.models ?? []).map((entry) => withTag(entry.name ?? entry.model ?? '')));
  return wanted.filter((model) => !have.has(withTag(model))).map((model) => ({ model, fix: `ollama pull ${model}` }));
}

export async function checkOllama({ url, chatModel, fetchImpl = fetch, timeoutMs = 2_000 }) {
  let tags;
  try {
    const response = await fetchImpl(`${url}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    tags = await response.json();
  } catch {
    return {
      ok: false,
      message: `Ollama is not running at ${url}.`,
      fix: 'Open the Ollama app, or run: brew services start ollama   (first time: brew install ollama)',
    };
  }
  const missing = missingModels(tags, [EMBED_MODEL, chatModel]);
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Ollama is running but ${missing.map((entry) => entry.model).join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not pulled yet.`,
      fix: missing.map((entry) => entry.fix).join('\n'),
    };
  }
  return { ok: true, message: `Ollama is running with ${EMBED_MODEL} and ${chatModel}` };
}

// Model-written code only ever runs in the OS sandbox; without one the step
// that runs the student's analysis is refused. That is a warning, not a stop:
// the rest of the demo works.
export function checkSandbox({ platform = process.platform, find }) {
  if (platform === 'darwin') {
    return find('/usr/bin/sandbox-exec')
      ? { ok: true, message: 'macOS sandbox (sandbox-exec) is available' }
      : { ok: false, warn: true, message: 'sandbox-exec was not found, so the agent cannot run code.', fix: 'It ships with macOS; check that /usr/bin/sandbox-exec exists.' };
  }
  if (platform === 'linux') {
    return find('bwrap')
      ? { ok: true, message: 'bubblewrap is available' }
      : { ok: false, warn: true, message: 'bubblewrap is not installed, so the agent cannot run code.', fix: 'sudo apt-get install bubblewrap' };
  }
  return { ok: false, warn: true, message: `No OS sandbox on ${platform}, so the agent cannot run code.` };
}

export function checkPortFree(port, inUse) {
  if (!inUse) return { ok: true, message: `port ${port} is free` };
  return {
    ok: false,
    message: `Port ${port} is already in use (another Scope Studio, or a dev server?).`,
    fix: `Stop whatever is using it (lsof -i :${port}), or choose another port with DEMO_ENGINE_PORT / DEMO_CLIENT_PORT.`,
  };
}
