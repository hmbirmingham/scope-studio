import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startServer } from '../helpers.js';

// Migration 039 gives the four verticals one shared vocabulary; each value
// must be accepted, and everything accepted before must still be.
describe('vertical node vocabulary', () => {
  let server;

  before(async () => {
    server = await startServer();
  });

  after(() => server.close());

  const node = (type, source) =>
    server.pool.query("INSERT INTO nodes (type, content, source) VALUES ($1, 'x', $2) RETURNING id", [type, source]).then((r) => r.rows[0].id);

  test('every vertical node type and source is accepted', async () => {
    const pairs = [
      ['schematic', 'kicad'], ['board', 'kicad'], ['symbol', 'kicad'], ['net', 'kicad'], ['footprint', 'kicad'], ['bom_row', 'kicad'],
      ['paper', 'zotero'], ['note', 'zotero'], ['excerpt', 'pdf'],
      ['derivation', 'physics'], ['computation', 'physics'],
      ['part', 'cad'], ['assembly', 'cad'],
    ];
    for (const [type, source] of pairs) assert.ok(await node(type, source), `${type}/${source}`);
  });

  test('earlier types, sources and relationships still work, and the new relationships link', async () => {
    const repo = await node('repo', 'github');
    const plan = await node('plan', 'agent');
    const net = await node('net', 'kicad');
    const symbol = await node('symbol', 'kicad');
    for (const type of ['depends_on', 'part_of', 'derived_from', 'answers']) {
      await server.pool.query('INSERT INTO node_relationships (source_id, target_id, type) VALUES ($1, $2, $3)', [plan, repo, type]);
    }
    for (const type of ['connects', 'implements', 'cites', 'contains']) {
      await server.pool.query('INSERT INTO node_relationships (source_id, target_id, type) VALUES ($1, $2, $3)', [net, symbol, type]);
    }
  });

  test('values outside the vocabulary are still refused', async () => {
    await assert.rejects(node('gadget', 'kicad'));
    await assert.rejects(node('net', 'solidworks'));
  });
});
