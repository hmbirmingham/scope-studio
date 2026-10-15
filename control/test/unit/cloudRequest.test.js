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

const png = (data = 'iVBORw0KGgo=') => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const withBlock = (block) => valid({ messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }, block] }] });

test('content blocks are accepted for text and images, base64 or by https URL', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 's' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'q' },
        png(),
        { type: 'image', source: { type: 'url', url: 'https://example.com/board.jpg' } },
      ],
    },
  ];
  assert.deepEqual(parseCloudRequest(valid({ messages })).value.messages, messages);
});

test('a block carries only the keys its type allows: caching and citations are not the client\'s to set', () => {
  const refused = [
    { type: 'text', text: 'context', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'context', citations: [] },
    { ...png(), cache_control: { type: 'ephemeral' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==', cache_control: { type: 'ephemeral' } } },
    { type: 'image', source: { type: 'url', url: 'https://example.com/a.png', headers: {} } },
    { type: 'image', source: { type: 'file', file_id: 'file_123' } },
    { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'd' } },
    { type: 'tool_use', id: 't', name: 'x', input: {} },
    { type: 'tool_result', tool_use_id: 't', content: 'r' },
    { type: 'server_tool_use', id: 's', name: 'web_search', input: {} },
    { type: 'web_search_tool_result', tool_use_id: 's', content: [] },
    { type: 'thinking', thinking: 't', signature: 's' },
  ];
  for (const block of refused) {
    assert.equal(parseCloudRequest(withBlock(block)).error?.code, 'field_not_allowed', JSON.stringify(block));
  }
});

test('an image source must have a valid base64 or https URL shape', () => {
  const malformed = [
    { type: 'image' },
    { type: 'image', source: 'https://example.com/a.png' },
    { type: 'image', source: {} },
    png(''),
    png('not base64!'),
    png('AAA'),
    png('A=A='),
    { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'AA==' } },
    { type: 'image', source: { type: 'base64', media_type: 'application/pdf', data: 'AA==' } },
    { type: 'image', source: { type: 'base64', data: 'AA==' } },
    { type: 'image', source: { type: 'url', url: 'http://example.com/a.png' } },
    { type: 'image', source: { type: 'url', url: 'file:///etc/passwd' } },
    { type: 'image', source: { type: 'url', url: 'not a url' } },
    { type: 'image', source: { type: 'url', url: `https://example.com/${'a'.repeat(2048)}` } },
    { type: 'image', source: { type: 'url' } },
  ];
  for (const block of malformed) {
    assert.equal(parseCloudRequest(withBlock(block)).error?.code, 'invalid_request', JSON.stringify(block));
  }
});

test('a refused key is named only when it looks like a name, so an error never echoes content', () => {
  const secret = 'PRIVATE stepper calibration notes';
  for (const body of [
    withBlock({ type: 'text', text: 'q', [secret]: 1 }),
    withBlock({ type: secret, text: 'q' }),
    withBlock({ type: 'image', source: { type: secret } }),
    valid({ [secret]: true }),
  ]) {
    const { error } = parseCloudRequest(body);
    assert.equal(error.code, 'field_not_allowed');
    assert.doesNotMatch(error.message, /PRIVATE/);
  }
  assert.match(parseCloudRequest(withBlock({ type: 'text', text: 'q', cache_control: {} })).error.message, /content\[1\] may not carry cache_control/);
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
