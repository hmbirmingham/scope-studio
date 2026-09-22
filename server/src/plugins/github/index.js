import { Octokit } from 'octokit';
import { tryEmbedDocument } from '../../lib/embeddings.js';
import { upsertNodeByExternalId } from '../../models/nodeStore.js';
import { DEFAULT_LIMITS, ingestRepoFiles } from './files.js';
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

async function fetchRepos(octokit, { since } = {}) {
  const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
    per_page: 100,
    sort: 'updated',
    direction: 'desc',
  });

  if (!since) return repos;
  return repos.filter((repo) => new Date(repo.updated_at) > since);
}

async function ingestRepos(octokit, repos, ownerId, limits) {
  const summary = { repos: 0, files: 0, chunks: 0, skipped: 0, pruned: 0, nodes: [] };
  for (const repo of repos) {
    const node = repoToNode(repo);
    const embedding = await tryEmbedDocument(node.content);
    const repoNode = await upsertNodeByExternalId({ ...node, ownerId, embedding });
    summary.repos += 1;
    summary.nodes.push(repoNode);

    const files = await ingestRepoFiles({ octokit, repo, repoNode, ownerId, limits });
    summary.files += files.files;
    summary.chunks += files.chunks;
    summary.skipped += files.skipped;
    summary.pruned += files.pruned;
  }
  return summary;
}

const githubPlugin = {
  name: 'github',
  displayName: 'GitHub',

  // Standard OAuth (authorization code) needs a browser redirect + callback,
  // so this exposes the two halves of the contract's single `authenticate`
  // step rather than one function call; see routes/plugins/github.js.
  authenticate: { getAuthorizeUrl, exchangeCodeForToken },

  // `octokit` and `limits` are injectable so the pipeline is testable without GitHub.
  async ingest(token, ownerId, { octokit = new Octokit({ auth: token }), limits = DEFAULT_LIMITS } = {}) {
    return ingestRepos(octokit, await fetchRepos(octokit), ownerId, limits);
  },

  async sync(token, since, ownerId, { octokit = new Octokit({ auth: token }), limits = DEFAULT_LIMITS } = {}) {
    return ingestRepos(octokit, await fetchRepos(octokit, { since }), ownerId, limits);
  },
};

export default githubPlugin;
