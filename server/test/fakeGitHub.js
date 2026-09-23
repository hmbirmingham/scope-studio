import { setTimeout as sleep } from 'node:timers/promises';

// Stands in for Octokit: paginate/getTree/getBlob are the whole surface the
// plugin uses. `state` is inspected by tests to see what was actually fetched.
export function fakeOctokit(state) {
  return {
    paginate: async (fn, params) => {
      if (state.failWith) {
        const error = new Error(state.failWith);
        if (state.failStatus) error.status = state.failStatus;
        throw error;
      }
      return fn(params);
    },
    rest: {
      repos: { listForAuthenticatedUser: async () => state.repos },
      git: {
        getTree: async ({ repo }) => {
          state.treesFetched?.push(repo);
          if (state.treeDelayMs) await sleep(state.treeDelayMs);
          return { data: { tree: state.trees[repo], truncated: false } };
        },
        getBlob: async ({ file_sha }) => ({
          data: { encoding: 'base64', content: Buffer.from(state.blobs[file_sha]).toString('base64') },
        }),
      },
    },
  };
}

export const fakeRepo = (id, name, isPrivate = false) => ({
  id,
  name,
  full_name: `hmb/${name}`,
  private: isPrivate,
  default_branch: 'main',
  description: `${name} repo`,
  updated_at: '2026-09-01T00:00:00Z',
  owner: { login: 'hmb' },
});
