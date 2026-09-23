import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { registeredSession, session, startServer } from '../helpers.js';

describe('graph endpoint', () => {
  let server;
  let api;
  let other;
  let ids;

  before(async () => {
    server = await startServer();
    api = await registeredSession(server.base);
    other = await registeredSession(server.base);

    const create = async (client, body) => (await client('POST', '/api/nodes', body)).data;
    const repo = await create(api, {
      type: 'repo',
      content: 'hmb/plates\nColony counting for dense plates',
      project: 'hmb/plates',
    });
    const file = await create(api, {
      type: 'file',
      content: 'src/quantify.py\n\ndef quantify_colonies(image): ...',
      project: 'hmb/plates',
    });
    const secret = await create(api, {
      type: 'file',
      content: 'firmware/motor.c\n\nvoid stepper_calibrate(void) { ... }',
      project: 'hmb/stage-firmware',
      privacy: 'local',
    });
    await api('POST', `/api/nodes/${file.id}/relationships`, { targetId: repo.id, type: 'part_of', weight: 1 });

    const strangerRepo = await create(other, { type: 'repo', content: 'someone/else\nNot yours', project: 'someone/else' });
    const strangerFile = await create(other, { type: 'file', content: 'their/file.py\nalso not yours', project: 'someone/else' });
    await other('POST', `/api/nodes/${strangerFile.id}/relationships`, { targetId: strangerRepo.id, type: 'part_of', weight: 1 });

    ids = { repo: repo.id, file: file.id, secret: secret.id, strangerRepo: strangerRepo.id };
  });
  after(() => server.close());

  test('returns the owner-scoped map: sized nodes, edges, and project totals', async () => {
    const { status, data } = await api('GET', '/api/graph');
    assert.equal(status, 200);
    assert.equal(data.total, 3);
    assert.equal(data.truncated, false);

    const file = data.nodes.find((node) => node.id === ids.file);
    assert.equal(file.label, 'src/quantify.py', 'first line of content is the hover label');
    assert.ok(file.tokenLength > 0, 'radius is drawn from tokenLength');
    assert.equal(file.accessCount, 0);
    assert.equal(file.confirmedUsefulCount, 0);
    assert.equal(file.privacy, 'cloud');
    assert.ok(!('content' in file), 'content stays out of the map payload');

    assert.deepEqual(data.edges, [{ source: ids.file, target: ids.repo, type: 'part_of', weight: 1 }]);

    const plates = data.projects.find((entry) => entry.project === 'hmb/plates');
    assert.equal(plates.nodes, 2);
    assert.ok(plates.tokens > 0);
    assert.equal(plates.privacy, 'cloud');
    assert.equal(
      data.projects.find((entry) => entry.project === 'hmb/stage-firmware').privacy,
      'local',
      'a project counts as private when any of its nodes is'
    );
  });

  test('another owner sees only their own nodes and edges', async () => {
    const { data } = await other('GET', '/api/graph');
    assert.equal(data.total, 2);
    assert.ok(data.nodes.every((node) => node.project === 'someone/else'));
    assert.ok(!data.nodes.some((node) => node.id === ids.file));
    assert.equal(data.edges.length, 1);
    assert.ok(data.edges.every((edge) => edge.target === ids.strangerRepo));
  });

  test('filters to one project', async () => {
    const { data } = await api('GET', '/api/graph?project=hmb%2Fstage-firmware');
    assert.equal(data.total, 1);
    assert.equal(data.nodes[0].id, ids.secret);
    assert.equal(data.edges.length, 0, 'edges are restricted to the returned nodes');
    assert.equal(data.projects.length, 2, 'project totals still describe the whole corpus');
  });

  test('reports truncation instead of silently dropping nodes', async () => {
    const { data } = await api('GET', '/api/graph?limit=2');
    assert.equal(data.nodes.length, 2);
    assert.equal(data.total, 3);
    assert.equal(data.truncated, true);
  });

  test('validation and authentication', async () => {
    assert.equal((await api('GET', '/api/graph?limit=abc')).status, 400);
    assert.equal((await session(server.base)('GET', '/api/graph')).status, 401);
  });
});
