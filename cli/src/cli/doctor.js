import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ollamaUp } from '../runners/local.js';
import { AGENT_DIRS, agentPath, vaultExists, vaultIsGit } from '../core/vault.js';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';

const run = promisify(execFile);

// Scan PATH rather than shelling out: no shell means no quoting questions, and
// an absolute path in config is honoured as-is.
async function which(bin) {
  if (bin.includes('/')) {
    try {
      await access(bin, constants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, bin);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

function line({ ok, label, detail, fix }) {
  const mark = ok === true ? '✅' : ok === false ? '❌' : '⚠️ ';
  return `${mark} ${label}${detail ? ` — ${detail}` : ''}${fix && ok !== true ? `\n     ↳ ${fix}` : ''}`;
}

export default async function doctor(config) {
  const checks = [];

  const ollama = await ollamaUp(config);
  checks.push(
    line({
      ok: ollama.up,
      label: 'ollama',
      detail: ollama.up ? `${ollama.models.length} models` : ollama.reason,
      fix: 'brew services start ollama',
    })
  );
  if (ollama.up) {
    const has = ollama.models.includes(config.ollama.model);
    checks.push(
      line({
        ok: has,
        label: `model ${config.ollama.model}`,
        detail: has ? 'pulled' : 'not pulled',
        fix: `ollama pull ${config.ollama.model}`,
      })
    );
  }

  const hasVault = await vaultExists(config);
  checks.push(line({ ok: hasVault, label: 'vault', detail: config.vault, fix: 'set vault in ~/.scope/config.json' }));

  if (hasVault) {
    const isGit = await vaultIsGit(config);
    checks.push(
      line({
        ok: isGit,
        label: 'vault is a git repo',
        detail: isGit ? 'agent writes are revertible' : 'agent writes would not be revertible',
        fix: `git -C "${config.vault}" init && git -C "${config.vault}" add -A && git -C "${config.vault}" commit -m "baseline before scope"`,
      })
    );
    const missing = [];
    for (const dir of AGENT_DIRS) {
      try {
        await access(agentPath(config, dir));
      } catch {
        missing.push(dir);
      }
    }
    checks.push(
      line({
        ok: missing.length === 0,
        label: `${config.agentPrefix}/ subdirectories`,
        detail: missing.length ? `missing ${missing.join(', ')}` : 'all present',
        fix: 'scope init',
      })
    );
  }

  const claude = await which(config.cloud.command);
  checks.push(
    line({
      ok: claude !== null,
      label: 'claude (headless cloud)',
      detail: claude ?? 'not on PATH',
      fix: 'export PATH="$HOME/.local/bin:$PATH"',
    })
  );
  checks.push(
    line({
      ok: config.cloud.dailyCloudSteps > 0 ? true : null,
      label: 'cloud budget',
      detail:
        config.cloud.dailyCloudSteps > 0
          ? `${config.cloud.dailyCloudSteps} steps/day`
          : 'uncalibrated — cloud steps are off until measured',
      fix: 'measure a week of runs, then set cloud.dailyCloudSteps',
    })
  );

  let docker = null;
  try {
    await run('docker', ['info'], { timeout: 5000 });
    docker = true;
  } catch {
    docker = false;
  }
  checks.push(
    line({
      ok: docker ? true : null,
      label: 'docker daemon',
      detail: docker ? 'running' : 'not running (needed from phase 3)',
      fix: 'open -a Docker',
    })
  );

  checks.push(
    line({
      ok: config.hasConfigFile ? true : null,
      label: 'config file',
      detail: config.hasConfigFile ? config.configPath : `none — using defaults (${config.configPath})`,
    })
  );

  console.log(checks.join('\n'));
  // A missing config file or an uncalibrated budget is not a failure; a broken
  // model or an unwritable vault is.
  return checks.some((c) => c.startsWith('❌')) ? 1 : 0;
}
