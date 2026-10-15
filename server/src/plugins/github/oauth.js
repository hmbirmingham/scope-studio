import { DeviceFlowError } from '../auth/deviceFlow.js';

// GitHub sign-in uses the device flow (see plugins/auth/deviceFlow.js), which
// needs only the OAuth app's public client id. The engine runs on the user's
// machine, where a client secret could be read by anyone with the binary and
// a callback URL has nowhere to point, so neither exists here.

const GITHUB_BASE = 'https://github.com';
const SCOPE = 'repo read:user';

// GITHUB_OAUTH_BASE points the flow at a local stand-in, in tests only.
function base() {
  return (process.env.GITHUB_OAUTH_BASE || GITHUB_BASE).replace(/\/$/, '');
}

export function getDeviceFlowConfig() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    // Service unavailable rather than a server fault: the engine is fine, it
    // just has not been told which GitHub app to sign in with.
    throw new DeviceFlowError(
      'not_configured',
      'GitHub is not configured: set GITHUB_CLIENT_ID in .env to the client id of a GitHub OAuth App ' +
        '(github.com/settings/developers) with "Enable Device Flow" ticked. No default is used.',
      { status: 503 }
    );
  }
  return {
    deviceCodeUrl: `${base()}/login/device/code`,
    tokenUrl: `${base()}/login/oauth/access_token`,
    clientId,
    scope: SCOPE,
  };
}

// GitHub's own error codes, turned into something the user can act on. The
// rest pass through as the provider worded them.
export function describeGitHubError(err) {
  switch (err.code) {
    case 'not_configured':
      return err.description;
    case 'device_flow_disabled':
      return 'Device sign-in is not enabled for this GitHub OAuth app — tick "Enable Device Flow" in its settings.';
    case 'incorrect_client_credentials':
      return 'GitHub does not recognise GITHUB_CLIENT_ID — check it matches the OAuth app.';
    case 'unreachable':
      return 'Could not reach GitHub — check the connection and try again.';
    default:
      return undefined;
  }
}

export const githubDeviceProvider = {
  config: getDeviceFlowConfig,
  describeError: describeGitHubError,
};
