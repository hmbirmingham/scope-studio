import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCloudRequest } from '../../src/routes/cloud.js';

const valid = (overrides = {}) => ({
  requestId: '6c1f2a90-0000-4000-8000-000000000000',
  messages: [{ role: 'user', content: 'q' }],
  ...overrides,
});

test('a minimal request takes the documented defaults', () => {
  assert.deepEqual(parseCloudRequest(valid()).value, {
    requestId: '6c1f2a90-0000-4000-8000-000000000000',
    messages: [{ role: 'user', content: 'q' }],
    cacheMarker: null,
    hard: false,
    sources: [],
  });
});

test('repeated source names are stored once', () => {
  assert.deepEqual(parseCloudRequest(valid({ sources: ['kicad', 'zotero', 'kicad'] })).value.sources, ['kicad', 'zotero']);
});

test('content blocks are accepted for text, images and documents', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 's' }] },
    { role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] },
  ];
  assert.ok(parseCloudRequest(valid({ messages })).value);
});

test('what is refused, and with which code', () => {
  const cases = [
    [null, 'invalid_request'],
    [[], 'invalid_request'],
    [valid({ model: 'claude-opus-5' }), 'field_not_allowed'],
    [valid({ stream: true }), 'field_not_allowed'],
    [valid({ requestId: 1234567890 }), 'invalid_request'],
    [valid({ messages: [{ role: 'system', content: 's' }, { role: 'system', content: 't' }, { role: 'user', content: 'q' }] }), 'invalid_request'],
    [valid({ messages: [{ role: 'system', content: [{ type: 'image', source: {} }] }, { role: 'user', content: 'q' }] }), 'invalid_request'],
    [valid({ messages: [{ role: 'user', content: [] }] }), 'invalid_request'],
    [valid({ messages: [{ role: 'user', content: [{ type: 'text' }] }] }), 'invalid_request'],
    [valid({ cacheMarker: 'x'.repeat(257) }), 'invalid_request'],
    [valid({ sources: ['has-dash'] }), 'invalid_sources'],
    [valid({ sources: null }), 'invalid_sources'],
  ];
  for (const [body, code] of cases) {
    assert.equal(parseCloudRequest(body).error?.code, code, JSON.stringify(body));
  }
});
