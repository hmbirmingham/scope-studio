function requireGithubCredentials() {
  const missing = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'BASE_URL'].filter(
    (key) => !process.env[key]
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Create a GitHub OAuth App at github.com/settings/developers and set these in .env. ' +
        'Refusing to proceed with a generated or default value.'
    );
  }
}

export function getCallbackUrl() {
  return `${process.env.BASE_URL}/api/plugins/github/callback`;
}

export function getAuthorizeUrl(state) {
  requireGithubCredentials();
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', getCallbackUrl());
  url.searchParams.set('scope', 'repo read:user');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeCodeForToken(code) {
  requireGithubCredentials();
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: getCallbackUrl(),
    }),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
  }
  return data.access_token;
}
