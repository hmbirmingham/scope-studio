import { clip, optionalInt, requireText } from './common.js';
import { ResearchError } from './text.js';

// research.web_search, behind a provider-neutral interface:
//
//   provider = { name, async search({ query, maxResults, signal }) → [{ title, url, snippet }] }
//
// can() has already required the `web` permission and an online engine; the
// capability refuses again if the run is offline, and refuses cleanly when no
// provider is configured. Results are untrusted text from the web: they are
// returned as data, never followed, and carry no library privacy.

const MAX_TITLE = 300;
const MAX_SNIPPET = 600;
const TIMEOUT_MS = 15_000;

function cleanResults(results, maxResults) {
  if (!Array.isArray(results)) throw new ResearchError('web_search_failed', 'the search provider returned no result list');
  const out = [];
  for (const result of results) {
    let url;
    try {
      url = new URL(String(result?.url ?? ''));
    } catch {
      continue;
    }
    // Only web pages: no file:, data: or javascript: links reach the graph.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    out.push({ title: clip(String(result?.title ?? url.hostname), MAX_TITLE), url: url.href, snippet: clip(String(result?.snippet ?? ''), MAX_SNIPPET) });
    if (out.length >= maxResults) break;
  }
  return out;
}

// A self-hosted SearXNG instance (its JSON API needs no key). Chosen by
// setting SEARXNG_URL; with nothing set there is no provider and the
// capability says so.
export function searxngProvider({ baseUrl, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  return {
    name: 'searxng',
    async search({ query, maxResults, signal }) {
      const url = new URL('search', base.href.endsWith('/') ? base.href : `${base.href}/`);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) throw new ResearchError('web_search_failed', `the search provider answered ${response.status}`);
      const data = await response.json();
      return (Array.isArray(data?.results) ? data.results : []).slice(0, maxResults).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
    },
  };
}

export function providerFromEnv(env = process.env) {
  return env.SEARXNG_URL ? searxngProvider({ baseUrl: env.SEARXNG_URL }) : null;
}

export async function webSearch(input, ctx, provider) {
  const query = requireText(input, 'query', { max: 500 });
  const maxResults = optionalInt(input, 'maxResults', { min: 1, max: 10, fallback: 5 });
  if (ctx.model?.offline === true || ctx.online === false) throw new ResearchError('offline', 'web search needs the engine to be online');
  if (!provider) throw new ResearchError('web_search_unavailable', 'no web search provider is configured (set SEARXNG_URL to a SearXNG instance)');

  let results;
  try {
    results = cleanResults(await provider.search({ query, maxResults, signal: ctx.signal }), maxResults);
  } catch (err) {
    if (err instanceof ResearchError) throw err;
    throw new ResearchError('web_search_failed', `${provider.name ?? 'the search provider'} failed: ${String(err?.message ?? err).slice(0, 300)}`);
  }
  const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`);
  return {
    output: { query, provider: provider.name ?? 'unknown', results },
    artifacts: [{ name: `Web search: ${clip(query, 120)}`, content: results.length > 0 ? lines.join('\n') : 'No results.' }],
  };
}
