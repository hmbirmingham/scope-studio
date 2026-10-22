// The graph plug-in: what every built-in role can do with the map itself.
// Each role template carries the `graph` tag, so these capabilities reach all
// of them. Reading needs no capability (every step already reads a packed
// slice of the graph); writing a finished piece of work does, so it is a
// step of its own that `can()` decides and the runner verifies and records.

const TITLE_MAX = 120;
// A write-back note is clipped at 4,000 characters (runner/writeBack.js);
// the title and a blank line take some of that, so the body stops short of it.
export const CONTENT_MAX = 3_800;

class GraphInputError extends Error {
  constructor(message) {
    super(message);
    this.code = 'invalid_input';
  }
}

function text(input, key, max) {
  const value = typeof input?.[key] === 'string' ? input[key].trim() : '';
  if (!value) throw new GraphInputError(`${key} must be a non-empty string`);
  if (value.length > max) throw new GraphInputError(`${key} must be at most ${max} characters`);
  return value;
}

// Saves a report, study guide, summary or table the agent wrote as an
// `artifact` node. The runner writes it once the step is verified, linked to
// the step that produced it and to the nodes it was derived from, and gives it
// their privacy: an artifact made from a private note stays on this machine.
async function writeArtifact(input) {
  const title = text(input, 'title', TITLE_MAX).replace(/\s+/g, ' ');
  const content = text(input, 'content', CONTENT_MAX);
  return {
    output: { text: `Saved “${title}” to the map (${content.length.toLocaleString('en-US')} characters).`, title, characters: content.length },
    artifacts: [{ name: title, content }],
  };
}

export function createGraphPlugin() {
  return {
    name: 'graph',
    capabilities: [
      {
        name: 'graph.write_artifact',
        description: 'Save a finished report, study guide, summary or table to the map.',
        tags: ['graph'],
        permission: 'write_notes',
        input: {
          type: 'object',
          required: ['title', 'content'],
          properties: {
            title: { type: 'string', description: 'A short title for the artifact.' },
            content: { type: 'string', description: 'The artifact itself, as Markdown.' },
          },
        },
        verifiers: [],
        run: writeArtifact,
      },
    ],
    verifiers: [],
  };
}

export default createGraphPlugin();
