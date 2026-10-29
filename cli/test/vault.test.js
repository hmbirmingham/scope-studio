import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentPath, parseFrontmatter, serializeFrontmatter, writeNote } from '../src/core/vault.js';

const config = { vault: '/vault', agentPrefix: 'scope' };

test('agentPath keeps writes inside the agent area', () => {
  assert.equal(agentPath(config, 'runs', 'a.md'), '/vault/scope/runs/a.md');
  assert.throws(() => agentPath(config, '../../etc/passwd'), /refusing to write outside/);
  assert.throws(() => agentPath(config, 'runs/../../../notes.md'), /refusing to write outside/);
  assert.throws(() => agentPath(config, '/etc/passwd'), /refusing to write outside/);
});

test('frontmatter round-trips the subset we write', () => {
  const fields = { id: 'r1', important: true, attempts: 3, tags: ['a', 'b'], title: 'has: colon' };
  const { fields: back, body } = parseFrontmatter(`${serializeFrontmatter(fields)}\nhello\n`);
  assert.deepEqual(back, fields);
  assert.equal(body.trim(), 'hello');
});

test('parseFrontmatter tolerates a note with no frontmatter', () => {
  const { fields, body } = parseFrontmatter('# plain note\n');
  assert.deepEqual(fields, {});
  assert.equal(body, '# plain note\n');
});

test('writeNote creates intermediate directories', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'scope-vault-'));
  const cfg = { vault, agentPrefix: 'scope' };
  const written = await writeNote(cfg, 'runs/2026/x.md', { fields: { id: 'x' }, body: 'body' });
  assert.match(await readFile(written, 'utf8'), /^---\nid: x\n---\n\nbody\n$/);
});
