import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

// Config is a plain file, not a database: the whole point of this tool is that
// its state is readable without it. Env vars win so a test run can point at a
// throwaway vault without touching the real one.
const CONFIG_PATH = process.env.SCOPE_CONFIG ?? join(homedir(), '.scope', 'config.json');

const DEFAULTS = {
  // The vault is a format, not a tool — a directory of markdown Obsidian
  // happens to open. Nothing here may assume Obsidian is installed or running.
  vault: join(homedir(), 'Documents', 'Obsidian Vault'),
  // Everything the agent writes lives under this prefix. It is a guest in a
  // vault full of notes it did not write.
  agentPrefix: 'scope',
  ollama: {
    host: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
    // qwen3:8b is a plain transformer, so its KV cache rewinds to where a
    // prompt diverges instead of only appending. That is why it beats the
    // hybrid-attention 9b on reworded follow-ups.
    model: process.env.OLLAMA_MODEL ?? 'qwen3:8b',
    // The window the local model is given. Raising it costs memory and time;
    // 16 GB will not hold a very large one alongside the model weights.
    contextTokens: Number(process.env.OLLAMA_NUM_CTX ?? 8192),
  },
  search: {
    // The search tier's key. Free tier, and Google trains on free-tier data, so
    // this tier only ever carries questions about the world — never anything
    // from the vault. Kept in the environment, not in this file, and never in
    // the vault.
    apiKey: process.env.GEMINI_API_KEY ?? null,
    model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  },
  cloud: {
    // Headless Claude Code on the Pro subscription. No API keys anywhere.
    command: process.env.SCOPE_CLAUDE_BIN ?? 'claude',
    // 20% of daily Pro usage, as a calibrated proxy. Week one measures; only
    // then does this number mean anything. Until calibrated, cloud is off.
    dailyCloudSteps: 0,
  },
};

function merge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? merge(base[key] ?? {}, value)
        : value;
  }
  return out;
}

/** Load config, falling back to defaults when no file exists yet. */
export async function loadConfig() {
  let fromFile = null;
  try {
    fromFile = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`config at ${CONFIG_PATH}: ${err.message}`);
  }
  const config = merge(DEFAULTS, fromFile);
  if (process.env.SCOPE_VAULT) config.vault = process.env.SCOPE_VAULT;
  return { ...config, configPath: CONFIG_PATH, hasConfigFile: fromFile !== null };
}

export { CONFIG_PATH, DEFAULTS };
