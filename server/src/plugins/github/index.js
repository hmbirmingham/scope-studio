import { Octokit } from 'octokit';
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

const githubPlugin = {
  name: 'github',
  displayName: 'GitHub',

  // Standard OAuth (authorization code) needs a browser redirect + callback,
  // so this exposes the two halves of the contract's single `authenticate`
  // step rather than one function call; see routes/plugins/github.js.
  authenticate: { getAuthorizeUrl, exchangeCodeForToken },

  async ingest(token) {
    const repos = await fetchRepos(token);
    const nodes = [];
    for (const repo of repos) {
      nodes.push(await upsertNodeByExternalId(repoToNode(repo)));
    }
    return nodes;
  },

  async sync(token, since) {
    const repos = await fetchRepos(token, { since });
    const nodes = [];
    for (const repo of repos) {
      nodes.push(await upsertNodeByExternalId(repoToNode(repo)));
    }
    return nodes;
  },
};

export default githubPlugin;
