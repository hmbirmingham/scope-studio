// Stand-in for GET /api/graph until feat/graph-data lands. Shapes match the
// real payload: node rows carry token_length (drives radius) but no content.
const PROJECTS = [
  { name: 'colony-counter', files: 64 },
  { name: 'stm32-stack', files: 42 },
  { name: 'huskybook', files: 38 },
  { name: 'scope-studio', files: 34 },
  { name: 'focus-guard', files: 26 },
];

const FILE_NAMES = [
  'segmentation.py', 'quantify.py', 'pipeline.py', 'loader.py', 'main.c', 'uart.c',
  'index.js', 'server.js', 'schema.sql', 'utils.ts', 'model.py', 'train.py',
];
const DECISIONS = [
  'watershed-over-contours', 'min-area-threshold', 'pgvector-over-pinecone',
  'session-auth-over-jwt', 'hnsw-over-ivfflat',
];

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

export function buildMockGraph() {
  const nodes = [];
  const edges = [];
  let counter = 0;

  for (const project of PROJECTS) {
    const repoId = `n${counter++}`;
    nodes.push({
      id: repoId,
      type: 'repo',
      project: project.name,
      label: project.name,
      token_length: 40 + randomInt(30),
      privacy: 'cloud',
    });

    const siblings = [];
    for (let i = 0; i < project.files; i++) {
      const roll = Math.random();
      const type = roll > 0.88 ? 'decision' : roll > 0.82 ? 'spec' : roll > 0.78 ? 'conversation' : 'file';
      const id = `n${counter++}`;
      nodes.push({
        id,
        type,
        project: project.name,
        label:
          type === 'decision'
            ? DECISIONS[randomInt(DECISIONS.length)]
            : FILE_NAMES[randomInt(FILE_NAMES.length)],
        token_length:
          type === 'file' ? 120 + randomInt(900) : type === 'decision' ? 60 + randomInt(140) : 80 + randomInt(300),
        privacy: Math.random() > 0.9 ? 'local' : 'cloud',
      });
      edges.push({ source: id, target: repoId, type: 'part_of' });
      siblings.push(id);
    }

    for (let i = 0; i < project.files * 0.35; i++) {
      const a = siblings[randomInt(siblings.length)];
      const b = siblings[randomInt(siblings.length)];
      if (a !== b) edges.push({ source: a, target: b, type: 'references' });
    }
  }

  return { nodes, edges };
}
