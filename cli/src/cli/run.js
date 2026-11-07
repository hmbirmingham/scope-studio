import { estimateTokens, fitsContext, generate, ollamaUp } from '../runners/local.js';
import { PrivacyRefusal, search, searchConfigured } from '../runners/search.js';
import { FetchRefusal, fetchSource, renderSource } from '../runners/fetch.js';
import { failureConstraint, runGates } from '../eval/check.js';
import { claimsOf, correctionNotes, groundQuotes, parseAnalysis } from '../eval/analysis.js';
import { select } from '../core/select.js';
import { cloudAllowance, decideRoute, describeRoute, questionDifficulty } from '../core/router.js';
import { writeRun } from '../core/ledger.js';
import { loadTask } from '../core/task.js';
import { agentPath, ensureAgentDirs } from '../core/vault.js';
import { readFile } from 'node:fs/promises';

// How much of the window a correction is allowed to need. Reserved up front so
// a retry cannot overflow a prompt that fit on the first attempt.
const CORRECTION_RESERVE_TOKENS = 512;

/**
 * How good an attempt was. Gates passed first, then grounded quotes as the
 * tiebreak — two attempts that clear the same gates are separated by how much
 * of their answer is actually anchored in the source.
 */
function score(attempt) {
  return attempt.results.filter((r) => r.ok).length * 1000 + (attempt.grounding?.grounded.length ?? 0);
}

/**
 * The coverage floor the corrector must not undercut, if the task has one. The
 * corrector has to know it: a note that reads as permission to delete a claim
 * will be taken, and then the coverage gate fails instead.
 */
function coverageFloor(task) {
  const gate = task.gates.find((g) => g.check === 'min_claims');
  return gate ? gate.arg : null;
}

/**
 * The prompt as the model will actually receive it. One function, used by the
 * budget check and by the attempt loop both — computing the budget against a
 * different string than the one that gets sent is how a selection comes in 43
 * tokens over the window.
 */
function asked(task, sources) {
  return sources ? `${task.prompt}\n\nSource material:\n\n${sources}` : task.prompt;
}

// A task with a use_case is given its rubric's prose verbatim: the constraints
// the work is judged by are the constraints the work is given. Without one, the
// gates are described instead, which is weaker but still honest.
function systemPrompt(task) {
  if (task.instructions) return task.instructions;
  return [
    'You are answering a task that will be checked automatically before it is accepted.',
    'The checks are:',
    ...task.gates.map((g) => `- ${g.id}: ${g.check}${g.arg !== undefined ? ` ${g.arg}` : ''}`),
    '',
    'Write only the answer. No preamble, no restatement of the task, no notes about these checks.',
  ].join('\n');
}

/**
 * The material a task works from, read straight out of the vault.
 *
 * Vault text is marked private. That marking is the whole input to the router's
 * first rule: a note of his own in the prompt forces the step local, ahead of
 * any other consideration including an explicit request for cloud.
 */
async function readSources(config, task) {
  const docs = [];
  for (const relPath of task.sources) {
    const text = await readFile(agentPath(config, relPath), 'utf8');
    docs.push({ label: relPath, attr: 'path', ref: relPath, text: text.trim(), privacy: 'local' });
  }
  return docs;
}

/**
 * Pages the task names, as source material. The text is independent of the
 * model that will write the answer, which is the only reason grounding its
 * quotes means anything.
 */
async function fetchPages(task) {
  const docs = [];
  for (const url of task.fetchUrls) {
    process.stderr.write(`  fetching: ${url}… `);
    const page = await fetchSource(url);
    process.stderr.write(`${page.chars} chars${page.truncated ? ' (truncated)' : ''} (${page.ms} ms)\n`);
    docs.push({
      label: url,
      attr: 'uri',
      ref: url,
      text: page.text,
      privacy: 'public',
      truncated: page.truncated,
      render: () => renderSource(page),
    });
  }
  return docs;
}

/**
 * Material the task fetches rather than reads. Each search is its own source
 * block, so a quote grounds against the passage that carried it rather than
 * against everything ever fetched.
 */
async function fetchSources(config, task) {
  if (!searchConfigured(config)) {
    throw new Error(
      `${task.id} needs the search tier for its "## Search" queries, but no GEMINI_API_KEY is set (see \`scope doctor\`)`
    );
  }
  const parts = [];
  for (const query of task.searchQueries) {
    process.stderr.write(`  searching: ${query}… `);
    const result = await search(config, { query });
    process.stderr.write(`${result.sources.length} sources (${result.ms} ms)\n`);
    // The answer and its citations both become groundable material: the prose
    // is what the search actually said, the uris are what it said it from.
    parts.push(
      `<search query="${query}">\n${result.output}\n</search>`,
      ...(result.sourceText ? [result.sourceText] : [])
    );
  }
  return parts.join('\n\n');
}

export default async function runCommand(config, taskRef, { verbose = false } = {}) {
  const task = await loadTask(config, taskRef);
  await ensureAgentDirs(config);
  const fromVault = task.sources.length ? await readSources(config, task) : [];
  let pages = [];
  if (task.fetchUrls.length) {
    try {
      pages = await fetchPages(task);
    } catch (err) {
      if (err instanceof FetchRefusal) throw new Error(`fetch refused: ${err.message}`);
      throw err;
    }
  }
  let fetched = '';
  if (task.searchQueries.length) {
    try {
      fetched = await fetchSources(config, task);
    } catch (err) {
      // A privacy refusal is a design outcome, not a crash: say which query was
      // refused and stop, rather than silently running without its material.
      if (err instanceof PrivacyRefusal) throw new Error(`search refused: ${err.message}`);
      throw err;
    }
  }
  const docs = [...fromVault, ...pages];
  if (task.sources.length) {
    console.error(`  sources: ${task.sources.join(', ')}`);
  }
  if (task.rubricSource) {
    console.error(`  rubric:  ${task.rubricSource} (${task.gates.length} gates, ${task.rubricLines.length} judged lines)`);
  }

  // Which tier serves this step. Privacy is decided by what is in the prompt,
  // not by what the task asked for: a vault note forces local ahead of
  // everything else. Cloud has no allowance until a week of runs calibrates
  // one, so this currently always resolves local — recorded anyway, so a trace
  // can say whether the router thought the model was big enough for the
  // question it was given.
  const system = systemPrompt(task);
  const local = await ollamaUp(config);
  const route = decideRoute({
    sources: docs,
    localAvailable: local.up,
    cloud: cloudAllowance(config),
    hard: questionDifficulty(task.prompt),
  });
  if (route.blocked) {
    throw new Error(`no tier can serve ${task.id}: wanted ${route.tier} (${route.reason}), ${route.blocked}`);
  }
  if (verbose) console.error(`  route:   ${describeRoute(route)}`);

  // Fit the source material to the window instead of refusing it.
  //
  // Refusing an overflow was the right first fix — Ollama drops the overflow
  // silently, and gates that judge an answer written from unseen material are
  // worse than no gates. But refusing is not a workflow: whole pages do not fit
  // an 8k window, so selection is what makes fetched sources usable at all.
  //
  // Selection runs ONCE, from the task's own question, before the first
  // attempt. Recomputing it per attempt would move the source text a quote has
  // to ground against between attempts, so a correction could fail for a reason
  // the model could not see.
  const verbatim = [...docs.map((doc) => (doc.render ? doc.render() : `<source ${doc.attr}="${doc.ref}">\n${doc.text}\n</source>`)), fetched]
    .filter(Boolean)
    .join('\n\n');
  let sources = verbatim;
  let selection = null;

  const whole = fitsContext(config, { system, prompt: asked(task, verbatim) });
  if (!whole.ok && docs.length) {
    // What is left for source material once everything else has its place. The
    // search tier's output is not selectable — it is already an extract — so it
    // is charged against the budget rather than competing for it. The
    // correction allowance is reserved too: a second attempt carries one note
    // per failing claim, and a retry that no longer fits would refuse the run
    // halfway through rather than before it started.
    const budget =
      whole.limit -
      whole.reserveForAnswer -
      CORRECTION_RESERVE_TOKENS -
      estimateTokens(system) -
      estimateTokens(asked(task, '')) -
      estimateTokens(fetched);
    selection = await select(config, task.prompt, docs, Math.max(0, budget));
    sources = [selection.text, fetched].filter(Boolean).join('\n\n');
    console.error(
      `  select:  ${selection.selected} of ${selection.total} chunks, ~${selection.tokens} tokens` +
        `, ${selection.dense ? 'dense+lexical' : 'lexical only'}${selection.elided ? `, ${selection.elided} elided` : ''}`
    );
  }

  const fit = fitsContext(config, { system, prompt: asked(task, sources) });
  if (!fit.ok) {
    throw new Error(
      `source material does not fit the local context even after selection: ~${fit.needed} tokens needed ` +
        `(including ${fit.reserveForAnswer} reserved for the answer), limit ${fit.limit}. ` +
        `Ollama would silently drop the overflow, so this is refused. ` +
        `Use fewer sources, or raise OLLAMA_NUM_CTX if the machine can hold it.`
    );
  }
  if (sources) console.error(`  context: ~${fit.needed} of ${fit.limit} tokens`);

  const startedAt = new Date();
  const attempts = [];
  let constraint = null;
  let best = null;

  for (let n = 1; n <= task.attempts; n += 1) {
    const base = asked(task, sources);
    const prompt = constraint
      ? `${base}\n\nYour previous answer failed these checks. Fix exactly these and change nothing else:\n${constraint}`
      : base;

    process.stderr.write(`  attempt ${n}/${task.attempts} on ${config.ollama.model}… `);
    const result = await generate(config, { system: systemPrompt(task), prompt });
    const { passed, results } = runGates(task.gates, result.output, { sources });
    process.stderr.write(`${passed ? 'passed' : 'failed'} (${result.ms} ms)\n`);

    // The in-work analysis: the answer decomposed into claims and the citations
    // behind them, recorded with the attempt. The gates read it, the trace keeps
    // it, and a grader can re-score it later without re-running the model.
    const analysis = parseAnalysis(result.output);
    const grounding = sources ? groundQuotes(analysis, sources) : null;
    const claimCount = claimsOf(analysis).length;

    const attempt = { n, ...result, passed, results, analysis, grounding, claimCount };
    attempts.push(attempt);
    if (best === null || score(attempt) > score(best)) best = attempt;
    if (verbose) {
      for (const r of results) console.error(`      ${r.ok ? '✅' : '❌'} ${r.id}: ${r.detail}`);
      if (grounding) {
        console.error(
          `      · ${claimCount} claims, ${grounding.grounded.length} grounded quotes, ${grounding.ungrounded.length} ungrounded`
        );
      }
    }
    if (passed) break;
    // Correct from the best attempt so far, not from the latest.
    //
    // Measured over two four-attempt runs: attempt 2 reached 9 of 10 gates and
    // attempts 3 and 4 fell back to 7, because each correction was built from
    // the attempt immediately before it. One bad attempt then poisons every
    // attempt after it, and the run reports its worst work. Correcting from the
    // best keeps a regression local — attempt 4 retries the same ground attempt
    // 3 lost rather than inheriting its collapse.
    constraint = [
      failureConstraint(best.results),
      ...(sources ? correctionNotes(best.analysis, sources, { minClaims: coverageFloor(task) }) : []),
    ]
      .filter(Boolean)
      .join('\n');
  }

  // The verdict is the best attempt's, not the last one's. A loop that can
  // regress must not throw away work it already had in hand.
  const passed = best.passed;
  const { path, commit } = await writeRun(config, { task, startedAt, attempts, passed, route, selection, best });

  console.log('');
  console.log(passed ? best.output : 'Task failed its checks. Nothing is being passed off as done.');
  if (!passed && attempts.length > 1) {
    const total = best.results.length;
    console.error(`closest: attempt ${best.n}, ${best.results.filter((r) => r.ok).length} of ${total} gates`);
  }
  console.log('');
  console.error(`trace: ${path}`);
  if (!commit.committed) console.error(`not committed: ${commit.reason}`);
  return passed ? 0 : 1;
}
