#!/usr/bin/env node
// `npm run demo` (docs/demo.md): checks what the demo needs, prepares the
// scope_demo database, seeds the student project, starts the engine and the
// app, and prints the address to open. Ctrl-C stops both.
//
// Free and local by construction: the engine is started signed out of the
// Scope Studio account service (CONTROL_URL empty), with agent networking off
// (WORKSPACE_OFFLINE=1) and an agent whose model policy is local_only, so
// every model call goes to Ollama on this machine and nothing is paid for.
//
// Every process is started with a fixed argument list and no shell.

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkNode,
  checkOllama,
  checkPgvector,
  checkPortFree,
  checkSandbox,
  databaseName,
  demoDatabaseUrl,
  describePostgresError,
  maintenanceUrl,
  safeDatabaseName,
} from './preflight.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, '../..');
const repoDir = resolve(serverDir, '..');
const clientDir = join(repoDir, 'client');
const DEFAULT_CHAT_MODEL = 'qwen3:8b';
const STOP_TIMEOUT_MS = 15_000;

// The engine loads .env files with dotenv, which otherwise prints a line
// about each one; the demo's output is meant to be read by a person.
process.env.DOTENV_CONFIG_QUIET ??= 'true';

const args = new Set(process.argv.slice(2));
const openBrowser = !args.has('--no-open') && process.env.DEMO_NO_OPEN !== '1';
const enginePort = Number(process.env.DEMO_ENGINE_PORT || 3001);
const clientPort = Number(process.env.DEMO_CLIENT_PORT || 5173);
const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
const chatModel = process.env.OLLAMA_CHAT_MODEL || DEFAULT_CHAT_MODEL;
const databaseUrl = demoDatabaseUrl();

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const red = paint('31');
const yellow = paint('33');

function say(text = '') {
  process.stdout.write(`${text}\n`);
}

function report(result) {
  if (result.ok) say(`  ${green('✓')} ${result.message}`);
  else if (result.warn) say(`  ${yellow('!')} ${result.message}${result.fix ? `\n      ${result.fix}` : ''}`);
  else say(`  ${red('✗')} ${result.message}`);
}

function stop(result) {
  report(result);
  if (result.fix) {
    say('');
    say(bold('  To fix it:'));
    for (const line of result.fix.split('\n')) say(`    ${line}`);
  }
  say('');
  say('  Then run npm run demo again.');
  process.exit(1);
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name) {
  if (name.startsWith('/')) return isExecutable(name) ? name : null;
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    if (isExecutable(join(dir, name))) return join(dir, name);
  }
  return null;
}

function portInUse(port) {
  return new Promise((resolvePromise) => {
    const probe = net.createServer();
    probe.once('error', () => resolvePromise(true));
    probe.once('listening', () => probe.close(() => resolvePromise(false)));
    probe.listen(port, '127.0.0.1');
  });
}

function run(command, commandArgs, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} ${commandArgs.join(' ')} exited with ${code}`))));
  });
}

// First run only: the packages the engine and the app need. npm prints its
// own progress, so this is never a silent download.
async function ensureDependencies() {
  for (const [label, dir] of [['engine', serverDir], ['app', clientDir]]) {
    if (existsSync(join(dir, 'node_modules'))) continue;
    say(`  Installing the ${label}'s packages (first run only)…`);
    await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir });
  }
  say(`  ${green('✓')} packages installed`);
}

async function preparePostgres(pg) {
  const name = databaseName(databaseUrl);
  if (!safeDatabaseName(name)) stop({ ok: false, message: `"${name}" is not a database name the demo will create.`, fix: 'Use lower-case letters, digits and _ in DEMO_DATABASE_URL.' });
  const admin = new pg.Client({ connectionString: maintenanceUrl(databaseUrl), connectionTimeoutMillis: 3_000 });
  try {
    await admin.connect();
  } catch (err) {
    stop(describePostgresError(err, databaseUrl));
  }
  try {
    const { rows: [server] } = await admin.query('SHOW server_version');
    report({ ok: true, message: `Postgres ${server.server_version}` });
    const { rowCount: vector } = await admin.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'");
    const pgvector = checkPgvector(vector > 0);
    if (!pgvector.ok) stop(pgvector);
    report(pgvector);
    const { rowCount: exists } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!exists) {
      await admin.query(`CREATE DATABASE "${name}"`);
      report({ ok: true, message: `created the ${name} database` });
    } else {
      report({ ok: true, message: `using the ${name} database` });
    }
  } catch (err) {
    stop(describePostgresError(err, databaseUrl));
  } finally {
    await admin.end().catch(() => {});
  }
}

async function waitFor(url, { timeoutMs, child, label }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} stopped while starting`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`${label} did not answer at ${url} within ${Math.round(timeoutMs / 1000)} s`);
}

// Keeps a child's last lines, so a crash can be explained, and passes on
// only what the person running the demo should see.
function capture(child, label, { show }) {
  const tail = [];
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        tail.push(line);
        if (tail.length > 40) tail.shift();
        if (show(line, stream === child.stderr)) say(dim(`  ${label} │ ${line}`));
      }
    });
  }
  return tail;
}

async function main() {
  const startedAt = Date.now();
  say('');
  say(bold('  Scope Studio · student demo'));
  say('');

  const node = checkNode();
  if (!node.ok) stop(node);
  report(node);
  await ensureDependencies();

  // Server packages are loaded only once they are known to be installed.
  const { default: pg } = await import('pg');
  await preparePostgres(pg);

  const ollama = await checkOllama({ url: ollamaUrl, chatModel });
  if (!ollama.ok) stop(ollama);
  report(ollama);

  report(checkSandbox({ find: findOnPath }));

  for (const port of [enginePort, clientPort]) {
    const free = checkPortFree(port, await portInUse(port));
    if (!free.ok) stop(free);
  }

  // The engine modules read these when they load.
  process.env.DATABASE_URL = databaseUrl;
  process.env.OLLAMA_URL = ollamaUrl;
  process.env.OLLAMA_CHAT_MODEL = chatModel;
  const { getPool } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  const { embedQuery } = await import('../lib/embeddings.js');
  const { seedDemo } = await import('./seed.js');

  await migrate(getPool(), { log: () => {} });
  report({ ok: true, message: 'database is up to date' });
  // A cold embedding model can take longer to load than one document's
  // embedding is allowed; loading it first means the seed gets embeddings.
  await embedQuery('warm up').catch(() => {});
  const seeded = await seedDemo();
  await getPool().end();
  report({ ok: true, message: `seeded “${seeded.project}”: ${Object.keys(seeded.nodeIds).length} notes, agent “${seeded.agent.name}”, ${seeded.tasks.length} tasks` });

  say('');
  say('  Starting…');
  const engineEnv = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(enginePort),
    // Only this machine can reach the engine; the app's proxy is on loopback.
    SCOPE_HOST: '127.0.0.1',
    BASE_URL: `http://localhost:${enginePort}`,
    DATABASE_URL: databaseUrl,
    OLLAMA_URL: ollamaUrl,
    OLLAMA_CHAT_MODEL: chatModel,
    // Signs this machine's browser in to the demo account (local mode).
    SCOPE_LOCAL_USER: seeded.user.email,
    // Signed out of the account service: Free, local answers only. Set
    // explicitly so a value in a .env file cannot change it.
    CONTROL_URL: '',
    WORKSPACE_OFFLINE: '1',
    // The session cookie's signing secret. A fresh random one per demo run,
    // held only in the engine's environment; the cookie it signs lives as
    // long as this run, and local mode signs the browser in again after.
    SESSION_SECRET: process.env.SESSION_SECRET || randomBytes(32).toString('hex'),
  };
  // Children run in their own process groups, so a terminal's Ctrl-C reaches
  // only this launcher, which then stops each of them exactly once.
  const engine = spawn(process.execPath, ['src/index.js'], { cwd: serverDir, env: engineEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const engineTail = capture(engine, 'engine', { show: (line, isError) => isError || /error|failed/i.test(line) });
  const children = [engine];

  let stopping = false;
  async function shutdown(code) {
    if (stopping) return;
    stopping = true;
    say('');
    say('  Stopping…');
    // The engine hands any run in flight back to the queue at its next step
    // boundary (or lets its lease expire); the app's server just exits.
    const exits = children.filter((child) => child.exitCode === null).map((child) => new Promise((resolvePromise) => child.once('exit', resolvePromise)));
    engine.kill('SIGINT');
    for (const child of children.slice(1)) child.kill('SIGTERM');
    const timer = setTimeout(() => children.forEach((child) => child.exitCode === null && child.kill('SIGKILL')), STOP_TIMEOUT_MS);
    await Promise.all(exits);
    clearTimeout(timer);
    say('  Stopped. Run npm run demo to start again (the demo data is reset each time).');
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  // If this launcher dies some other way, it does not leave them running.
  process.on('exit', () => children.forEach((child) => child.exitCode === null && child.kill('SIGKILL')));

  const failed = (label, tail) => (code) => {
    if (stopping) return;
    say(red(`\n  The ${label} stopped unexpectedly (exit ${code}). Its last output:`));
    for (const line of tail.slice(-20)) say(dim(`    ${line}`));
    shutdown(1);
  };
  engine.once('exit', failed('engine', engineTail));

  try {
    await waitFor(`http://127.0.0.1:${enginePort}/health`, { timeoutMs: 30_000, child: engine, label: 'the engine' });
    report({ ok: true, message: `engine on http://127.0.0.1:${enginePort}` });

    const vite = join(clientDir, 'node_modules', 'vite', 'bin', 'vite.js');
    await run(process.execPath, [vite, 'build', '--logLevel', 'warn'], { cwd: clientDir, stdio: ['ignore', 'ignore', 'inherit'] });
    report({ ok: true, message: 'app built' });
    const preview = spawn(process.execPath, [vite, 'preview', '--port', String(clientPort), '--strictPort', '--host', '127.0.0.1'], {
      cwd: clientDir,
      env: { ...process.env, SCOPE_ENGINE_URL: `http://127.0.0.1:${enginePort}` },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    children.push(preview);
    const previewTail = capture(preview, 'app', { show: (_line, isError) => isError });
    preview.once('exit', failed('app server', previewTail));
    await waitFor(`http://127.0.0.1:${clientPort}/`, { timeoutMs: 30_000, child: preview, label: 'the app' });
  } catch (err) {
    say(red(`\n  ${err.message}`));
    for (const line of engineTail.slice(-20)) say(dim(`    ${line}`));
    return shutdown(1);
  }

  const url = `http://localhost:${clientPort}`;
  say('');
  say(bold(`  Ready in ${Math.round((Date.now() - startedAt) / 1000)} s. Open ${url}`));
  say(dim(`  Model: ${chatModel} on this machine · nothing leaves it · Ctrl-C to stop`));
  say('');

  // Loads the chat model into memory now, so the first step of the first run
  // does not wait for it. A request with no prompt only loads the model.
  fetch(`${ollamaUrl}/api/generate`, { method: 'POST', body: JSON.stringify({ model: chatModel, keep_alive: '1h' }) })
    .then((response) => response.ok && say(dim(`  ${chatModel} is loaded and ready.`)))
    .catch(() => {});

  if (openBrowser && process.platform === 'darwin') execFile('open', [url], () => {});
}

main().catch((err) => {
  say(red(`\n  The demo could not start: ${err.message}`));
  process.exit(1);
});
