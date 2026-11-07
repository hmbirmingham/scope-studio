import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FetchRefusal, assertFetchable, fetchSource, htmlToText, renderSource } from '../src/runners/fetch.js';
import { parseTask } from '../src/core/task.js';

test('only public http(s) is fetchable', () => {
  assert.equal(assertFetchable('https://example.com/a').hostname, 'example.com');
  assert.throws(() => assertFetchable('file:///etc/passwd'), FetchRefusal);
  assert.throws(() => assertFetchable('not a url'), FetchRefusal);
});

test('loopback and private addresses are refused, so a task file cannot forge a request', () => {
  for (const url of [
    'http://localhost:3001/admin',
    'http://127.0.0.1/',
    'http://192.168.1.1/',
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',
  ]) {
    assert.throws(() => assertFetchable(url), FetchRefusal, `should refuse ${url}`);
  }
});

test('html becomes text a model can quote and a gate can match', () => {
  const html = `<html><head><style>p{color:red}</style><script>var x=1</script></head>
    <body><h1>Recall</h1><p>Recall@k measures coverage.</p><p>nDCG measures ordering &amp; gain.</p></body></html>`;
  const text = htmlToText(html);
  // Headings survive as markdown headings: chunking uses them as boundaries and
  // as its relevance signal, so losing them here would cost both.
  assert.match(text, /^# Recall\n/);
  assert.match(text, /Recall@k measures coverage\./);
  assert.match(text, /nDCG measures ordering & gain\./);
  assert.doesNotMatch(text, /var x=1|color:red/, 'scripts and styles are gone');
});

test('block boundaries become breaks so sentences do not fuse', () => {
  assert.equal(htmlToText('<li>one</li><li>two</li>'), 'one\ntwo');
  assert.equal(htmlToText('a<br>b'), 'a\nb');
});

test('entities are decoded, since a quote has to match character for character', () => {
  assert.equal(htmlToText('<p>&quot;k&quot; &lt; 10 &#8212; see &#39;docs&#39;</p>'), '"k" < 10 — see \'docs\'');
});

test('a fetched page renders as the same source block the gates already read', () => {
  const block = renderSource({ url: 'https://example.com/a', text: 'body text', truncated: false });
  assert.equal(block, '<source uri="https://example.com/a">\nbody text\n</source>');
  assert.match(
    renderSource({ url: 'https://example.com/a', text: 't', truncated: true }),
    /truncated="true"/
  );
});

test('truncation is reported rather than silent', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    headers: new Map([['content-type', 'text/plain']]),
    text: async () => 'x'.repeat(100),
  });
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => 'text/plain' },
    text: async () => 'x'.repeat(100),
  });
  try {
    const page = await fetchSource('https://example.com/a', { maxChars: 10 });
    assert.equal(page.truncated, true);
    assert.equal(page.chars, 100, 'the real length is kept, not the truncated one');
    assert.equal(page.text.length, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an http error names the host and status', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, headers: { get: () => '' }, text: async () => '' });
  try {
    await assert.rejects(() => fetchSource('https://example.com/a'), /example\.com returned HTTP 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a task declares the pages it works from', () => {
  const task = parseTask(
    '---\nid: t\n---\n## Task\nq\n\n## Fetch\n- https://example.com/a\n- https://example.com/b\n\n## Gates\n- g: non_empty\n',
    't.md'
  );
  assert.deepEqual(task.fetchUrls, ['https://example.com/a', 'https://example.com/b']);
});
