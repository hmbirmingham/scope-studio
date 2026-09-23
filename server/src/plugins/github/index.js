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

async function ingestRepos(octokit, repos, ownerId, limits, onProgress) {
  const summary = { repos: 0, files: 0, chunks: 0, skipped: 0, pruned: 0, nodes: [] };
  for (const repo of repos) {
    onProgress?.({
      repo: repo.full_name,
      reposDone: summary.repos,
      reposTotal: repos.length,
      files: summary.files,
      chunks: summary.chunks,
    });
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
  onProgress?.({
    repo: null,
    reposDone: summary.repos,
    reposTotal: repos.length,
    files: summary.files,
    chunks: summary.chunks,
  });
  return summary;
}

// Only the fields a picker needs. `select` is the subset the user asked for,
// matched on full_name because that is what the map calls a project.
function selectRepos(repos, select) {
  if (!select || select.length === 0) return repos;
  const wanted = new Set(select);
  return repos.filter((repo) => wanted.has(repo.full_name));
}

// Applying an edit never trusts the stored chunk: chunks are truncated for
// retrieval, so the file is re-fetched, the search text must still match, and
// the change lands on a branch as a pull request the user can read before
// merging. Nothing is pushed to a default branch.
async function applyEdit(octokit, { project, path, search, replace, message, branchPrefix = 'scope-studio' }) {
  const [owner, repo] = project.split('/');
  const { data: repository } = await octokit.rest.repos.get({ owner, repo });
  const base = repository.default_branch;

  const { data: file } = await octokit.rest.repos.getContent({ owner, repo, path, ref: base });
  const current = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');

  const occurrences = current.split(search).length - 1;
  if (occurrences === 0) {
    throw new Error(`the text to change is no longer in ${path} — the file changed since it was read`);
  }
  if (occurrences > 1) {
    throw new Error(`the text to change appears ${occurrences} times in ${path}; the edit is ambiguous`);
  }

  const branch = `${branchPrefix}/${Date.now().toString(36)}`;
  const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` });
  await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: ref.object.sha });

  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    branch,
    message,
    sha: file.sha,
    content: Buffer.from(current.replace(search, replace), 'utf8').toString('base64'),
  });

  const { data: pull } = await octokit.rest.pulls.create({
    owner,
    repo,
    base,
    head: branch,
    title: message,
    body: 'Proposed in Scope Studio and approved by the repository owner.',
  });
  return { branch, url: pull.html_url, number: pull.number };
}

const githubPlugin = {
  name: 'github',
  displayName: 'GitHub',

  // Standard OAuth (authorization code) needs a browser redirect + callback,
  // so this exposes the two halves of the contract's single `authenticate`
  // step rather than one function call; see routes/plugins/github.js.
  authenticate: { getAuthorizeUrl, exchangeCodeForToken },

  // A seam for tests and for the routes, which build one client per request.
  createClient(token) {
    return new Octokit({ auth: token });
  },

  // What the repository picker shows, before anything is ingested.
  async listRepos(token, { octokit = githubPlugin.createClient(token) } = {}) {
    const repos = await fetchRepos(octokit);
    return repos.map((repo) => ({
      id: repo.id,
      fullName: repo.full_name,
      description: repo.description ?? null,
      private: repo.private,
      updatedAt: repo.updated_at,
      // Privacy is inherited at ingest; showing it up front means no surprises
      // about which repositories stay on the machine.
      privacy: repo.private ? 'local' : 'cloud',
    }));
  },

  // `octokit` and `limits` are injectable so the pipeline is testable without GitHub.
  async ingest(
    token,
    ownerId,
    { octokit = githubPlugin.createClient(token), limits = DEFAULT_LIMITS, repos, onProgress } = {}
  ) {
    const all = await fetchRepos(octokit);
    return ingestRepos(octokit, selectRepos(all, repos), ownerId, limits, onProgress);
  },

  // The plugin that owns a file is what writes to it; the editing pipeline
  // only knows this contract.
  async applyEdit(token, edit, { octokit = githubPlugin.createClient(token) } = {}) {
    return applyEdit(octokit, edit);
  },

  async sync(token, since, ownerId, { octokit = githubPlugin.createClient(token), limits = DEFAULT_LIMITS } = {}) {
    return ingestRepos(octokit, await fetchRepos(octokit, { since }), ownerId, limits);
  },
};

export default githubPlugin;
