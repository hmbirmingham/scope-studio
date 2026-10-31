import { readFile } from 'node:fs/promises';
import { planIngest } from '../connectors/granola.js';
import { commitVault, ensureAgentDirs, readNote, writeNote, agentPath } from '../core/vault.js';
import { access } from 'node:fs/promises';

const SOURCES = { granola: planIngest };

/** What the vault already holds, so an unchanged note is left alone. */
async function existingState(config, relPaths) {
  const state = new Map();
  for (const relPath of relPaths) {
    try {
      await access(agentPath(config, relPath));
    } catch {
      continue;
    }
    const { fields } = await readNote(config, relPath);
    state.set(relPath, fields.granola_updated_at);
  }
  return state;
}

export default async function ingestCommand(config, source, payloadPath, { dryRun = false } = {}) {
  const plan = SOURCES[source];
  if (!plan) throw new Error(`unknown source "${source}". Known: ${Object.keys(SOURCES).join(', ')}`);
  if (!payloadPath) throw new Error(`ingest ${source} needs a payload file (the MCP client lands in phase 1)`);

  const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
  const meetings = Array.isArray(payload) ? payload : payload.meetings;
  if (!Array.isArray(meetings)) throw new Error(`${payloadPath}: expected an array of meetings`);

  await ensureAgentDirs(config);
  // Two passes: plan against an empty vault to learn which paths to look up,
  // then re-plan knowing what is already there. Cheaper than reading the whole
  // vault, and it keeps the transform pure.
  const { writes: candidates } = plan(meetings, new Map());
  const existing = await existingState(config, candidates.map((w) => w.relPath));
  const { writes, skipped } = plan(meetings, existing);

  for (const write of writes) {
    console.log(`  ${dryRun ? 'would write' : write.isUpdate ? 'update' : 'create'}  ${write.relPath}`);
    if (!dryRun) await writeNote(config, write.relPath, write);
  }
  for (const skip of skipped) console.log(`  skip    ${skip.relPath} (${skip.reason})`);

  if (dryRun) {
    console.log(`\n${writes.length} would be written, ${skipped.length} skipped. Nothing was changed.`);
    return 0;
  }
  if (writes.length === 0) {
    console.log('\nNothing to do: the vault is already current.');
    return 0;
  }

  const commit = await commitVault(config, `scope: ingest ${writes.length} note(s) from ${source}`);
  console.log(`\n${writes.length} written, ${skipped.length} skipped.`);
  if (!commit.committed) console.error(`not committed: ${commit.reason}`);
  return 0;
}
