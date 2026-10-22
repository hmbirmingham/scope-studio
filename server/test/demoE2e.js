// Runs `npm run demo` exactly as a person would, but with the scripted demo
// model (demoModel.js) standing in for Ollama's chat, so the browser test of
// the demo (client/e2e/demo.spec.js) is deterministic and needs no model.
// Embeddings go to a real Ollama when DEMO_E2E_EMBED_URL names one; without
// it retrieval runs lexical-only, as it does whenever embeddings are missing.
//
// The database must be a local one the test may reset: DEMO_DATABASE_URL.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoReply } from './demoModel.js';
import { startFakeOllama } from './fakeOllama.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const databaseUrl = process.env.DEMO_DATABASE_URL;
if (!databaseUrl || !LOCAL_HOSTS.has(new URL(databaseUrl).hostname)) {
  console.error('demoE2e: DEMO_DATABASE_URL must name a local test database');
  process.exit(1);
}

const fake = await startFakeOllama({ embedUrl: process.env.DEMO_E2E_EMBED_URL });
fake.state.respond = (request) => demoReply(request.messages);
// A real model takes a while; a short pause after the first token of each
// reply lets the browser see a step running before it finishes.
fake.state.pauseAfterFirstMs = Number(process.env.DEMO_E2E_PAUSE_MS ?? 700);

const launcher = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '../src/demo/launch.js'), '--no-open'], {
  env: { ...process.env, OLLAMA_URL: fake.url },
  stdio: 'inherit',
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  launcher.kill('SIGTERM');
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
launcher.once('exit', async (code) => {
  await fake.close();
  process.exit(code ?? 0);
});
