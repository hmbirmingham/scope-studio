import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { registeredSession, session, startServer } from '../helpers.js';

describe('nodes', () => {
  let server;
  let api;
  before(async () => {
    server = await startServer();
    api = await registeredSession(server.base);
  });
  after(() => server.close());

  test('requires authentication', async () => {
    const anonymous = session(server.base);
    assert.equal((await anonymous('GET', '/api/nodes')).status, 401);
    assert.equal((await anonymous('POST', '/api/nodes', { type: 'repo', content: 'x' })).status, 401);
  });

  test('validates type and privacy', async () => {
    assert.equal((await api('POST', '/api/nodes', { type: 'bogus', content: 'x' })).status, 400);
    assert.equal((await api('POST', '/api/nodes', { type: 'repo' })).status, 400);
    assert.equal(
      (await api('POST', '/api/nodes', { type: 'repo', content: 'x', privacy: 'secret' })).status,
      400
    );
  });

  test('full lifecycle: create, read (bumps access), list, update, relate, delete cascades', async () => {
    const created = await api('POST', '/api/nodes', {
      type: 'repo',
      content: 'scope-studio repo',
      project: 'scope-studio',
      privacy: 'local',
    });
    assert.equal(created.status, 201);
    const node = created.data;
    assert.equal(node.source, 'manual');
    assert.equal(node.privacy, 'local');
    assert.equal(node.access_count, 0);
    assert.ok(node.token_length > 0, 'token_length is generated on insert');
    assert.equal(node.embedding, undefined, 'raw vector is not exposed by the API');

    const fetched = await api('GET', `/api/nodes/${node.id}`);
    assert.equal(fetched.data.access_count, 1);

    const listed = await api('GET', '/api/nodes?project=scope-studio&type=repo');
    assert.deepEqual(listed.data.map((row) => row.id), [node.id]);

    const updated = await api('PATCH', `/api/nodes/${node.id}`, { content: 'scope-studio repo (updated)' });
    assert.equal(updated.data.content, 'scope-studio repo (updated)');

    const other = (await api('POST', '/api/nodes', { type: 'decision', content: 'chose pgvector' })).data;
    const relationship = await api('POST', `/api/nodes/${node.id}/relationships`, {
      targetId: other.id,
      type: 'depends_on',
      weight: 0.8,
    });
    assert.equal(relationship.status, 201);
    assert.equal(relationship.data.weight, 0.8);
    assert.equal(
      (await api('POST', `/api/nodes/${node.id}/relationships`, { targetId: other.id, type: 'bogus' })).status,
      400
    );
    assert.equal((await api('GET', `/api/nodes/${node.id}/relationships`)).data.length, 1);

    assert.equal((await api('DELETE', `/api/nodes/${node.id}`)).status, 204);
    assert.equal((await api('GET', `/api/nodes/${node.id}`)).status, 404);
    const { rows } = await server.pool.query('SELECT count(*)::int AS count FROM node_relationships');
    assert.equal(rows[0].count, 0, 'relationships cascade on node delete');
  });
});
