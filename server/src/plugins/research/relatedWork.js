import { assertModelMayRead, byline, clip, complete, optionalInt, optionalRefs, requireText, scopeFor } from './common.js';
import { rankPapers, resolveRefs } from './sweep.js';
import { ResearchError, findCitations, findQuotes, terms } from './text.js';

// research.related_work: a related-work paragraph drafted by the model from
// the library's excerpts and nothing else. The draft must cite with the
// library's own citekeys, and only the papers whose excerpts it was given;
// its verifiers (research.citations_resolve, research.quotes_match) check
// that, and that every direct quotation is verbatim, before anything is kept.

const EXCERPTS_PER_PAPER = 2;
const EXCERPT_CHARS = 900;

export function draftMessages({ topic, maxWords, sources }) {
  return [
    {
      role: 'system',
      content: [
        'You write the related-work paragraph of a paper, grounded only in the excerpts given.',
        `Write one paragraph of at most ${maxWords} words about the topic.`,
        'Cite every claim with the citekey of the paper it comes from, in square brackets: [@citekey]. Cite only the citekeys listed below.',
        'To quote, copy the words exactly from an excerpt, put them in double quotes and follow them with the citekey and page: "exact words" [@citekey, p. 2].',
        'Do not use anything you know from outside the excerpts. Reply with the paragraph only.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Topic: ${topic}`,
        '',
        ...sources.flatMap(({ paper, excerpts }) => [
          `[@${paper.citekey}] ${paper.title ?? '(untitled)'} (${byline(paper)})`,
          ...excerpts.map((excerpt) => `  p. ${excerpt.page}: ${clip(excerpt.text, EXCERPT_CHARS)}`),
          '',
        ]),
      ].join('\n'),
    },
  ];
}

function references(sources) {
  return sources.map(({ paper }) => `- @${paper.citekey}: ${paper.title ?? '(untitled)'} (${byline(paper)})${paper.doi ? `. doi:${paper.doi}` : ''}`).join('\n');
}

export async function relatedWork(input, ctx) {
  const topic = requireText(input, 'topic', { max: 500 });
  const maxPapers = optionalInt(input, 'maxPapers', { min: 1, max: 8, fallback: 5 });
  const maxWords = optionalInt(input, 'maxWords', { min: 50, max: 600, fallback: 200 });
  const projects = scopeFor(ctx, input);
  const named = await resolveRefs(ctx, projects, optionalRefs(input, 'papers', { max: 8 }));
  const words = terms(topic);
  if (words.length === 0) throw new ResearchError('invalid_input', 'the topic has no words to search for');

  const ranked = await rankPapers(ctx, { projects, words, paperIds: named?.map((paper) => paper.id) ?? null, maxPapers, excerptsPerPaper: EXCERPTS_PER_PAPER });
  // Grounded only in excerpts: a paper the library has no matching page text
  // for (no PDF, or a PDF that did not match) is not offered at all.
  const sources = ranked.filter((entry) => entry.excerpts.length > 0).map((entry) => ({ paper: entry.paper, excerpts: entry.excerpts }));
  if (sources.length === 0) throw new ResearchError('no_excerpts', `no excerpt in the library matches "${clip(topic, 200)}"; ingest the papers' PDFs first`);
  assertModelMayRead(ctx, sources.flatMap((source) => source.excerpts));

  const reply = await complete(ctx.model, { messages: draftMessages({ topic, maxWords, sources }), maxTokens: Math.ceil(maxWords * 2.5) + 100, signal: ctx.signal });
  const paragraph = reply.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
  if (!paragraph) throw new ResearchError('empty_draft', 'the model returned no paragraph');

  const cited = [...new Set(findCitations(paragraph).map((cite) => cite.citekey))];
  const allowed = sources.map((source) => source.paper.citekey);
  return {
    output: {
      topic,
      paragraph,
      words: paragraph.split(/\s+/).length,
      citations: cited.map((citekey) => ({ citekey })),
      allowedCitekeys: allowed,
      requireCitations: true,
      quotes: findQuotes(paragraph),
      sources: sources.map(({ paper, excerpts }) => ({ paperId: paper.id, citekey: paper.citekey, excerptIds: excerpts.map((excerpt) => excerpt.id) })),
    },
    touchedNodeIds: sources.flatMap(({ paper, excerpts }) => [paper.id, ...excerpts.map((excerpt) => excerpt.id)]),
    artifacts: [{ name: `Related work: ${clip(topic, 120)}`, content: `${paragraph}\n\nReferences:\n${references(sources.filter(({ paper }) => cited.some((key) => key.toLowerCase() === paper.citekey.toLowerCase())))}` }],
  };
}
