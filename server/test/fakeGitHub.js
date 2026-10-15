import http from 'node:http';
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

// An obviously fake device code, so a test can search every response body
// for it and be sure the browser never saw it.
export const FAKE_DEVICE_CODE = 'fake-device-code-never-in-a-response';
export const FAKE_USER_CODE = 'FAKE-0000';
export const FAKE_ACCESS_TOKEN = 'fake-access-token';

// Speaks GitHub's two device-flow endpoints, answering the way GitHub does
// (HTTP 200 with an `error` field for every refusal). `state.tokenReplies`
// is consumed one reply per token poll, so a test scripts the whole sign-in,
// e.g. ['authorization_pending', 'slow_down', 'connected']. Every request is
// recorded so a test can check what the engine actually sent.
export async function startFakeGitHubOAuth() {
  const state = {
    requests: [],
    startError: null,
    interval: 5,
    expiresIn: 900,
    tokenReplies: [],
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    state.requests.push({ method: req.method, url: req.url, accept: req.headers.accept, form });
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'POST' && req.url === '/login/device/code') {
      if (state.startError) {
        return res.end(JSON.stringify({ error: state.startError, error_description: 'refused by the fake' }));
      }
      return res.end(JSON.stringify({
        device_code: FAKE_DEVICE_CODE,
        user_code: FAKE_USER_CODE,
        verification_uri: 'https://github.test/login/device',
        expires_in: state.expiresIn,
        interval: state.interval,
      }));
    }
    if (req.method === 'POST' && req.url === '/login/oauth/access_token') {
      if (form.device_code !== FAKE_DEVICE_CODE) {
        return res.end(JSON.stringify({ error: 'incorrect_device_code' }));
      }
      const reply = state.tokenReplies.shift() ?? 'authorization_pending';
      if (reply === 'connected') {
        return res.end(JSON.stringify({ access_token: FAKE_ACCESS_TOKEN, token_type: 'bearer', scope: 'repo,read:user' }));
      }
      const body = { error: reply };
      if (reply === 'slow_down') body.interval = state.interval + 5;
      return res.end(JSON.stringify(body));
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return {
    url: `http://localhost:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}
