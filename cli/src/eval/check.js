// Deterministic gates. These run before any model judges anything: they are
// free, fast, and they cannot be talked out of a verdict. The rule they exist
// to enforce is that every step has a check before it has a model — a step
// nobody can check is a question for the user, not a step.

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
 * @returns {{passed: boolean, results: Array<{id: string, check: string, ok: boolean, detail: string}>}}
 */
export function runGates(gates, output) {
  const results = gates.map((gate) => {
    const fn = CHECKS[gate.check];
    if (!fn) return { id: gate.id, check: gate.check, ok: false, detail: `unknown check "${gate.check}"` };
    try {
      const { ok, detail } = fn(output, gate.arg);
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
