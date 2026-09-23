// Prompt layout per ARCHITECTURE.md §5: the system prompt is a byte-identical
// static prefix on every request so Ollama can reuse its KV cache; retrieved
// nodes follow relevance-descending (small models attend most to the start),
// and the question comes last, after the material it is asked about.

const EDITING = `- When the user asks you to change code, keep the prose to a sentence and give the change as an edit block:
<edit path="exact/path/from/the/context">
<<<<<<< SEARCH
lines copied exactly from the excerpt
=======
the replacement lines
>>>>>>> REPLACE
</edit>
- Only edit a file that appears in the context, use its exact path, and copy the SEARCH lines verbatim from the excerpt — they are matched character for character against the real file.
- When the user asks you to run, test or benchmark something, name the project's own script on its own line:
<run>test</run>
Only a script the project declares in package.json can run, it runs in the project's working copy, and only after the user approves it. You are shown the output afterwards.
- Never abbreviate inside SEARCH. No "...", no "rest of the function", no summarising comments: copy the exact lines you are replacing, and keep the block small — a few lines around the change, not the whole file. Nothing is applied until the user approves it.`;

const RULES = `- Answer from the context. Cite the excerpts you use inline by number, like [1] or [2][3].
- If the context does not contain the answer, say so in one sentence, then give your best general answer and label it as general knowledge.
- Quote code, names, and values exactly as they appear. Never invent file paths, functions, or APIs.
- Be concise: lead with the answer, then only the detail that supports it.
${EDITING}`;

export const SYSTEM_PROMPTS = {
  strict_xml: `You are Scope Studio, an assistant that answers questions about the user's own engineering projects.

The user's message holds a <context> block of numbered excerpts retrieved from their projects, followed by a <question>.
${RULES}`,
  markdown: `You are Scope Studio, an assistant that answers questions about the user's own engineering projects.

The user's message holds a "Context" section of numbered excerpts retrieved from their projects, followed by a "Question" section.
${RULES}`,
};

const NO_CONTEXT = "No matching excerpts were found in the user's projects.";

function ordered(selected, nodeOrder) {
  if (nodeOrder !== 'relevance_desc') throw new Error(`unknown node_order: ${nodeOrder}`);
  return [...selected].sort((a, b) => b.score - a.score);
}

function xmlContext(nodes, startIndex) {
  const sources = nodes.map(({ node }, i) => {
    const project = node.project ? ` project="${node.project}"` : '';
    return `<source index="${startIndex + i + 1}" type="${node.type}"${project}>\n${node.content}\n</source>`;
  });
  return `<context>\n${sources.length > 0 ? sources.join('\n') : NO_CONTEXT}\n</context>`;
}

function markdownContext(nodes, startIndex) {
  const sources = nodes.map(({ node }, i) => {
    const label = node.project ? `${node.type} · ${node.project}` : node.type;
    return `### [${startIndex + i + 1}] ${label}\n\n${node.content}`;
  });
  return `## Context\n\n${sources.length > 0 ? sources.join('\n\n---\n\n') : NO_CONTEXT}`;
}

// The context block and the question are built separately so a block that was
// already prefilled can be reused verbatim under a reworded question — the
// model then re-reads only the question.
export function buildContextBlock(sources, config, startIndex = 0) {
  return config.prompt_structure === 'strict_xml'
    ? xmlContext(sources, startIndex)
    : markdownContext(sources, startIndex);
}

export function buildQuestionBlock(query, config) {
  return config.prompt_structure === 'strict_xml'
    ? `<question>\n${query}\n</question>`
    : `## Question\n\n${query}`;
}

export function composeMessages(contextBlock, query, config) {
  const system = SYSTEM_PROMPTS[config.prompt_structure];
  if (!system) throw new Error(`unknown prompt_structure: ${config.prompt_structure}`);
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${contextBlock}\n\n${buildQuestionBlock(query, config)}` },
  ];
}

// Returns the nodes in prompt order too: citation [n] refers to sources[n - 1].
export function buildMessages({ query, selected, config }) {
  const sources = ordered(selected, config.node_order);
  const contextBlock = buildContextBlock(sources, config);
  return { messages: composeMessages(contextBlock, query, config), sources, contextBlock };
}

// A follow-up turn appended to an existing conversation: everything above stays
// byte-identical, so the model re-reads nothing. Nodes the earlier context did
// not carry are numbered on from it, keeping citations stable across the thread.
export function buildFollowUp(query, config, { sources = [], startIndex = 0 } = {}) {
  if (!SYSTEM_PROMPTS[config.prompt_structure]) {
    throw new Error(`unknown prompt_structure: ${config.prompt_structure}`);
  }
  const question = buildQuestionBlock(query, config);
  return sources.length === 0
    ? question
    : `${buildContextBlock(sources, config, startIndex)}\n\n${question}`;
}
