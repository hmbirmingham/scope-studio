import { estimateTokens, fitsContext, generate } from '../runners/local.js';
import { PrivacyRefusal, search, searchConfigured } from '../runners/search.js';
import { FetchRefusal, fetchSource, renderSource } from '../runners/fetch.js';
import { failureConstraint, runGates } from '../eval/check.js';
import { claimsOf, correctionNotes, groundQuotes, parseAnalysis } from '../eval/analysis.js';
import { writeRun } from '../core/ledger.js';
import { loadTask } from '../core/task.js';
import { agentPath, ensureAgentDirs } from '../core/vault.js';
import { readFile } from 'node:fs/promises';

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

/** The material a task works from, read straight out of the vault. */
async function readSources(config, task) {
  const parts = [];
  for (const relPath of task.sources) {
    const text = await readFile(agentPath(config, relPath), 'utf8');
    parts.push(`<source path="${relPath}">\n${text.trim()}\n</source>`);
  }
  return parts.join('\n\n');
}

/**
 * Pages the task names, as source material. The text is independent of the
 * model that will write the answer, which is the only reason grounding its
 * quotes means anything.
 */
async function fetchPages(task) {
  const parts = [];
  for (const url of task.fetchUrls) {
    process.stderr.write(`  fetching: ${url}… `);
    const page = await fetchSource(url);
    process.stderr.write(`${page.chars} chars${page.truncated ? ' (truncated)' : ''} (${page.ms} ms)\n`);
    parts.push(renderSource(page));
  }
  return parts.join('\n\n');
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
  const fromVault = task.sources.length ? await readSources(config, task) : '';
  let pages = '';
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
  const sources = [fromVault, pages, fetched].filter(Boolean).join('\n\n');
  if (task.sources.length) {
    console.error(`  sources: ${task.sources.join(', ')}`);
  }
  if (task.rubricSource) {
    console.error(`  rubric:  ${task.rubricSource} (${task.gates.length} gates, ${task.rubricLines.length} judged lines)`);
  }

  // Refuse an oversized prompt instead of letting Ollama drop the overflow.
  // A silently truncated source is the worst kind of failure here: the gates
  // still run, they just judge an answer written from material the model never
  // saw.
  const fit = fitsContext(config, { system: systemPrompt(task), prompt: `${task.prompt}\n\n${sources}` });
  if (!fit.ok) {
    throw new Error(
      `source material does not fit the local context: ~${fit.needed} tokens needed ` +
        `(including ${fit.reserveForAnswer} reserved for the answer), limit ${fit.limit}. ` +
        `Ollama would silently drop the overflow, so this is refused. ` +
        `Use fewer sources, or raise OLLAMA_NUM_CTX if the machine can hold it.`
    );
  }
  if (sources) console.error(`  context: ~${fit.needed} of ${fit.limit} tokens`);

  const startedAt = new Date();
  const attempts = [];
  let constraint = null;

  for (let n = 1; n <= task.attempts; n += 1) {
    const asked = sources ? `${task.prompt}\n\nSource material:\n\n${sources}` : task.prompt;
    const prompt = constraint
      ? `${asked}\n\nYour previous answer failed these checks. Fix exactly these and change nothing else:\n${constraint}`
      : asked;

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

    attempts.push({ n, ...result, passed, results, analysis, grounding, claimCount });
    if (verbose) {
      for (const r of results) console.error(`      ${r.ok ? '✅' : '❌'} ${r.id}: ${r.detail}`);
      if (grounding) {
        console.error(
          `      · ${claimCount} claims, ${grounding.grounded.length} grounded quotes, ${grounding.ungrounded.length} ungrounded`
        );
      }
    }
    if (passed) break;
    // Correction is per-claim, not a blanket retry: the next attempt is told
    // which claims failed and why, so it repairs those and leaves the rest.
    constraint = [failureConstraint(results), ...(sources ? correctionNotes(analysis, sources) : [])]
      .filter(Boolean)
      .join('\n');
  }

  const passed = attempts.at(-1).passed;
  const { path, commit } = await writeRun(config, { task, startedAt, attempts, passed });

  console.log('');
  console.log(passed ? attempts.at(-1).output : 'Task failed its checks. Nothing is being passed off as done.');
  console.log('');
  console.error(`trace: ${path}`);
  if (!commit.committed) console.error(`not committed: ${commit.reason}`);
  return passed ? 0 : 1;
}
