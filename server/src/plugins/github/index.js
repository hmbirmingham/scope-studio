import { Octokit } from 'octokit';
import { tryEmbedDocument } from '../../lib/embeddings.js';
import { upsertNodeByExternalId } from '../../models/nodeStore.js';
import { getAuthorizeUrl, exchangeCodeForToken } from './oauth.js';

function repoToNode(repo) {
  return {
    type: 'repo',
    content: [repo.full_name, repo.description ?? ''].filter(Boolean).join('\n'),
    source: 'github',
    externalId: String(repo.id),
    project: repo.full_name,
    privacy: repo.private ? 'local' : 'cloud',
  };
}

async function fetchRepos(token, { since } = {}) {
  const octokit = new Octokit({ auth: token });
  const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
    per_page: 100,
    sort: 'updated',
    direction: 'desc',
  });

  if (!since) return repos;
  return repos.filter((repo) => new Date(repo.updated_at) > since);
}

async function upsertRepos(repos) {
  const nodes = [];
  for (const repo of repos) {
    const node = repoToNode(repo);
    const embedding = await tryEmbedDocument(node.content);
    nodes.push(await upsertNodeByExternalId({ ...node, embedding }));
  }
  return nodes;
}

const githubPlugin = {
  name: 'github',
  displayName: 'GitHub',

  // Standard OAuth (authorization code) needs a browser redirect + callback,
  // so this exposes the two halves of the contract's single `authenticate`
  // step rather than one function call; see routes/plugins/github.js.
  authenticate: { getAuthorizeUrl, exchangeCodeForToken },

  async ingest(token) {
    return upsertRepos(await fetchRepos(token));
  },

  async sync(token, since) {
    return upsertRepos(await fetchRepos(token, { since }));
  },
};

export default githubPlugin;
