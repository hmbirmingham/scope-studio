// Fetching pages the task names. This exists because grounding needs real
// retrieved text, and Google Search grounding turned out to be unavailable on
// the free tier: measured 2026-11-07, generation 200 on every model, the same
// call with google_search 429 on all of them.
//
// The important property is not that fetching is free. It is that the text is
// INDEPENDENT OF THE GENERATOR. A quote checked against a model's own prose
// always matches, so sourcing from a model would make quotes_grounded pass
// while grounding nothing. Source text must come from outside the model that
// writes the answer, or the gate is theatre.

const BLOCKED_HOSTS = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

export class FetchRefusal extends Error {}

/**
 * Only public http(s). A task file is just text, and a URL in one should not be
 * able to reach the loopback interface or the private network this machine sits
 * on — that would turn "brief me on this page" into a request forgery.
 */
export function assertFetchable(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new FetchRefusal(`not a URL: ${url}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new FetchRefusal(`refusing ${parsed.protocol}// — only http and https are fetched`);
  }
  if (BLOCKED_HOSTS.test(parsed.hostname)) {
    throw new FetchRefusal(`refusing ${parsed.hostname} — local and private addresses are not fetched`);
  }
  return parsed;
}

/**
 * HTML to something a model can quote from and a gate can match against.
 * Deliberately plain: scripts, styles and markup out, text and spacing kept.
 * Quotes are matched after whitespace folding, so exact entity handling matters
 * more than exact layout.
 */
export function htmlToText(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Headings become markdown headings rather than bare lines. A page's own
    // section structure is the cheapest relevance signal it offers, and once
    // chunking leaves neighbours out it is also what makes an excerpt readable
    // — so it has to survive the tag stripping that follows.
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]>/gi, '\n\n')
    // Block boundaries become line breaks so sentences do not fuse together.
    .replace(/<\/(p|div|section|article|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/**
 * One page as source material. Truncation is reported rather than silent: a
 * quote that fails to ground because its page was cut short is a confusing
 * failure, and the trace should be able to say so.
 */
export async function fetchSource(url, { timeoutMs = 20_000, maxChars = 40_000 } = {}) {
  const parsed = assertFetchable(url);
  const started = Date.now();
  let res;
  try {
    res = await fetch(parsed.href, {
      redirect: 'follow',
      headers: { accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(`${parsed.hostname} timed out after ${timeoutMs}ms`);
    throw new Error(`could not reach ${parsed.hostname}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`${parsed.hostname} returned HTTP ${res.status}`);

  const type = res.headers.get('content-type') ?? '';
  const raw = await res.text();
  const text = /html/i.test(type) ? htmlToText(raw) : raw.trim();
  const truncated = text.length > maxChars;

  return {
    url: parsed.href,
    text: truncated ? text.slice(0, maxChars) : text,
    truncated,
    chars: text.length,
    ms: Date.now() - started,
  };
}

/** The `<source>` block form every gate already understands. */
export function renderSource({ url, text, truncated }) {
  return `<source uri="${url}"${truncated ? ' truncated="true"' : ''}>\n${text}\n</source>`;
}
