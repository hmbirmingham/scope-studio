// Prompt layout per ARCHITECTURE.md §5: the system prompt is a byte-identical
// static prefix on every request so Ollama can reuse its KV cache; retrieved
// nodes follow relevance-descending (small models attend most to the start),
// and the question comes last, after the material it is asked about.

const RULES = `- Answer from the context. Cite the excerpts you use inline by number, like [1] or [2][3].
- If the context does not contain the answer, say so in one sentence, then give your best general answer and label it as general knowledge.
- Quote code, names, and values exactly as they appear. Never invent file paths, functions, or APIs.
- Be concise: lead with the answer, then only the detail that supports it.`;

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

function xmlBody(nodes, query) {
  const sources = nodes.map(({ node }, i) => {
    const project = node.project ? ` project="${node.project}"` : '';
    return `<source index="${i + 1}" type="${node.type}"${project}>\n${node.content}\n</source>`;
  });
  const context = sources.length > 0 ? sources.join('\n') : NO_CONTEXT;
  return `<context>\n${context}\n</context>\n\n<question>\n${query}\n</question>`;
}

function markdownBody(nodes, query) {
  const sources = nodes.map(({ node }, i) => {
    const label = node.project ? `${node.type} · ${node.project}` : node.type;
    return `### [${i + 1}] ${label}\n\n${node.content}`;
  });
  const context = sources.length > 0 ? sources.join('\n\n---\n\n') : NO_CONTEXT;
  return `## Context\n\n${context}\n\n## Question\n\n${query}`;
}

// Returns the nodes in prompt order too: citation [n] refers to sources[n - 1].
export function buildMessages({ query, selected, config }) {
  const structure = config.prompt_structure;
  const system = SYSTEM_PROMPTS[structure];
  if (!system) throw new Error(`unknown prompt_structure: ${structure}`);

  const sources = ordered(selected, config.node_order);
  const body = structure === 'strict_xml' ? xmlBody(sources, query) : markdownBody(sources, query);
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: body },
    ],
    sources,
  };
}
