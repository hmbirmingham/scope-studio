import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { EDGE_WEIGHTS } from '../../src/retrieval/retrieve.js';
import { DECAY_LAMBDA } from '../../src/retrieval/score.js';

// The ranking needs a recency rate for every node type and a weight for every
// relationship type the database accepts; a missing entry scored NaN and put
// the node at an arbitrary rank. This reads the allowed values from the
// migrations, so a vertical that adds a type fails here until it is weighted.
const migrations = join(dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations');

function allowedValues(table, constraint) {
  const pattern = new RegExp(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK \\(type IN \\(([\\s\\S]*?)\\)\\);`, 'g');
  let latest = null;
  for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    for (const match of readFileSync(join(migrations, file), 'utf8').matchAll(pattern)) latest = match[1];
  }
  assert.ok(latest, `no ${constraint} found in the migrations`);
  return [...latest.replace(/--.*$/gm, '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('scoring vocabulary matches the database vocabulary', () => {
  test('every node type has a recency rate', () => {
    const types = allowedValues('nodes', 'nodes_type_check');
    assert.ok(types.includes('schematic') && types.includes('finding'), 'reads the latest constraint');
    const missing = types.filter((type) => !Number.isFinite(DECAY_LAMBDA[type]));
    assert.deepEqual(missing, [], `node types without a DECAY_LAMBDA: ${missing.join(', ')}`);
  });

  test('every relationship type has an expansion weight', () => {
    const types = allowedValues('node_relationships', 'node_relationships_type_check');
    assert.ok(types.includes('connects') && types.includes('derived_from'), 'reads the latest constraint');
    const missing = types.filter((type) => !Number.isFinite(EDGE_WEIGHTS[type]));
    assert.deepEqual(missing, [], `relationship types without an EDGE_WEIGHT: ${missing.join(', ')}`);
  });
});
