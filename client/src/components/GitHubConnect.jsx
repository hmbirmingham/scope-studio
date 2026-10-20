import { useEffect, useState } from 'react';
import './GitHubConnect.css';

// What ended the last attempt, in words the user can act on.
const ENDED = {
  expired: 'The code expired before it was entered. Start again for a fresh one.',
  denied: 'Access was declined on GitHub. Nothing was connected.',
};

function CopyCode({ code }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // Clipboard access can be refused; the code is selectable by hand.
    }
  }

  return (
    <div className="device-code-row">
      <code className="device-code">{code}</code>
      <button type="button" className="sources-action" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// GitHub sign-in by the device flow: the engine never holds a client secret,
// so instead of a redirect the user types a short code on github.com in a
// new tab while this panel waits for GitHub to say yes.
export default function GitHubConnect({ configured, signIn, onConnect, onCancel }) {
  if (!configured) {
    return (
      <div className="inspector-block">
        <div className="inspector-block-title">Connect GitHub</div>
        <p className="key-note">
          GitHub is not set up on this engine. Set GITHUB_CLIENT_ID in the engine&apos;s .env to the
          client id of a GitHub OAuth app with device sign-in enabled, then restart it.
        </p>
      </div>
    );
  }

  if (signIn?.state === 'connected') {
    return <div className="sources-done">Connected to GitHub.</div>;
  }

  if (signIn?.state === 'waiting') {
    return (
      <div className="inspector-block">
        <div className="inspector-block-title">Connect GitHub</div>
        <p className="key-note">Enter this code on GitHub to let Scope Studio read your repositories.</p>
        <CopyCode code={signIn.userCode} />
        <a className="sources-connect device-open" href={signIn.verificationUri} target="_blank" rel="noopener noreferrer">
          Open {signIn.verificationUri.replace(/^https?:\/\//, '')} ↗
        </a>
        <div className="device-waiting">
          <span className="device-dot" /> Waiting for approval on GitHub…
          <button type="button" className="key-clear device-cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const starting = signIn?.state === 'starting';
  const problem = signIn?.state === 'failed' ? signIn.error : ENDED[signIn?.state];
  return (
    <div className="inspector-block">
      {problem && <div className="sources-error">{problem}</div>}
      <button type="button" className="sources-connect device-start" onClick={onConnect} disabled={starting}>
        {starting ? 'Asking GitHub…' : problem ? 'Try again' : 'Connect GitHub'}
      </button>
    </div>
  );
}
