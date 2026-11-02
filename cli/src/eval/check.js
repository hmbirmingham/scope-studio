// Deterministic gates. These run before any model judges anything: they are
// free, fast, and they cannot be talked out of a verdict. The rule they exist
// to enforce is that every step has a check before it has a model — a step
// nobody can check is a question for the user, not a step.

import { copiedClaims, groundQuotes, parseAnalysis, uncitedClaims } from './analysis.js';

const WORDS = /[A-Za-z0-9'’-]+/g;

function words(text) {
  return text.match(WORDS) ?? [];
}

// Paragraphs, not lines: a wrapped sentence is one claim, not three.
function paragraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

const CHECKS = {
  non_empty: (out) => ({
    ok: out.trim().length > 0,
    detail: out.trim().length > 0 ? 'has content' : 'output was empty',
  }),

  min_words: (out, n) => {
    const count = words(out).length;
    return { ok: count >= n, detail: `${count} words, minimum ${n}` };
  },

  max_words: (out, n) => {
    const count = words(out).length;
    return { ok: count <= n, detail: `${count} words, maximum ${n}` };
  },

  must_match: (out, pattern) => {
    const re = new RegExp(pattern, 'm');
    return { ok: re.test(out), detail: re.test(out) ? `matched ${pattern}` : `no match for ${pattern}` };
  },

  must_not_match: (out, pattern) => {
    const re = new RegExp(pattern, 'gim');
    const hits = [...out.matchAll(re)].map((m) => m[0]);
    return {
      ok: hits.length === 0,
      detail: hits.length ? `found ${[...new Set(hits)].slice(0, 5).join(', ')}` : `no match for ${pattern}`,
    };
  },

  // The gate that makes a research brief trustworthy: no paragraph of claims
  // without something to attribute them to.
  every_paragraph_matches: (out, pattern) => {
    const re = new RegExp(pattern, 'm');
    // Headings are excluded from the numbering as well as from the verdict, so
    // "paragraph 2" means the second paragraph a reader would count.
    const failing = paragraphs(out)
      .filter((p) => !p.startsWith('#'))
      .map((p, i) => ({ i: i + 1, p }))
      .filter(({ p }) => !re.test(p));
    return {
      ok: failing.length === 0,
      detail: failing.length
        ? `paragraph${failing.length > 1 ? 's' : ''} ${failing.map((f) => f.i).join(', ')} lack ${pattern}`
        : `all paragraphs match ${pattern}`,
    };
  },

  json_parses: (out) => {
    try {
      JSON.parse(out);
      return { ok: true, detail: 'parsed as JSON' };
    } catch (err) {
      return { ok: false, detail: `not JSON: ${err.message}` };
    }
  },

  // Local 8B models reliably emit these when they have run out of substance.
  // Cheaper to catch with a regex than with a judge.
  // The check that turns hallucination from a judged question into a settled
  // one: a cited quote either occurs in the source material or it does not.
  quotes_grounded: (out, _arg, ctx) => {
    if (!ctx?.sources) return { ok: false, detail: 'no source material to ground against' };
    const { grounded, ungrounded } = groundQuotes(parseAnalysis(out), ctx.sources);
    if (grounded.length === 0 && ungrounded.length === 0) {
      return { ok: false, detail: 'no quotes cited at all' };
    }
    return {
      ok: ungrounded.length === 0,
      detail: ungrounded.length
        ? `${ungrounded.length} of ${grounded.length + ungrounded.length} quotes are not in the source: ${ungrounded
            .slice(0, 3)
            .map((u) => `"${u.quote.slice(0, 60)}"`)
            .join('; ')}`
        : `all ${grounded.length} quotes found in the source`,
    };
  },

  // The counterweight to quotes_grounded: that gate is trivially satisfiable by
  // making every claim a copy of a source line, which passes and is worthless.
  claims_not_copied: (out, _arg, ctx) => {
    if (!ctx?.sources) return { ok: false, detail: 'no source material to compare against' };
    const copied = copiedClaims(parseAnalysis(out), ctx.sources);
    return {
      ok: copied.length === 0,
      detail: copied.length
        ? `${copied.length} claim(s) copied from the source rather than explained: ${copied
            .slice(0, 3)
            .map((c) => `"${c.text.slice(0, 50)}"`)
            .join('; ')}`
        : 'every claim restates the source in its own words',
    };
  },

  // A claim with no citation cannot be grounded or refuted, so it is treated as
  // a failure rather than given the benefit of the doubt.
  claims_cited: (out) => {
    const uncited = uncitedClaims(parseAnalysis(out));
    return {
      ok: uncited.length === 0,
      detail: uncited.length
        ? `${uncited.length} claim(s) with no supporting quote: ${uncited
            .slice(0, 3)
            .map((c) => `"${c.text.slice(0, 50)}"`)
            .join('; ')}`
        : 'every claim carries a quote',
    };
  },

  no_placeholder: (out) => {
    const re = /\b(TODO|TBD|lorem ipsum|as an AI|I (?:cannot|can't|am unable to)|\[insert|XXX)\b/gi;
    const hits = [...out.matchAll(re)].map((m) => m[0]);
    return {
      ok: hits.length === 0,
      detail: hits.length ? `placeholder text: ${[...new Set(hits)].join(', ')}` : 'no placeholder text',
    };
  },
};

export function knownChecks() {
  return Object.keys(CHECKS);
}

/**
 * Run one step's gates against its output.
 * @param {Array} gates
 * @param {string} output
 * @param {{sources?: string}} ctx the material the step worked from, for the
 *   grounding checks. Checks that do not need it ignore it.
 * @returns {{passed: boolean, results: Array<{id: string, check: string, ok: boolean, detail: string}>}}
 */
export function runGates(gates, output, ctx = {}) {
  const results = gates.map((gate) => {
    const fn = CHECKS[gate.check];
    if (!fn) return { id: gate.id, check: gate.check, ok: false, detail: `unknown check "${gate.check}"` };
    try {
      const { ok, detail } = fn(output, gate.arg, ctx);
      return { id: gate.id, check: gate.check, ok, detail };
    } catch (err) {
      return { id: gate.id, check: gate.check, ok: false, detail: `check threw: ${err.message}` };
    }
  });
  return { passed: results.every((r) => r.ok), results };
}

/** The violated lines, as the constraint the next attempt is given. */
export function failureConstraint(results) {
  return results
    .filter((r) => !r.ok)
    .map((r) => `- ${r.detail}`)
    .join('\n');
}
