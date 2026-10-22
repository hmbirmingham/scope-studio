import { useEffect, useState } from 'react';

// Every map and chat route is owner-scoped, so the client needs a session
// before it can draw anything.
export default function LoginGate({ children }) {
  const [state, setState] = useState('checking');
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    // An engine started in local mode (the demo) says so when this browser is
    // not signed in, and then signs it in to the demo account without a
    // password; any other engine never says so, and the form below is shown.
    // The body is read before going on: the session is saved while the
    // response ends, and a request sent on its headers alone could beat it.
    const signInLocally = () =>
      fetch('/api/auth/local', { method: 'POST', headers: { 'X-Scope-Local-Signin': '1' } }).then(async (response) => {
        await response.text();
        return response.ok;
      });
    fetch('/api/auth/session')
      .then(async (response) => {
        if (response.ok) return setState('in');
        const body = await response.json().catch(() => ({}));
        setState(body.localSignin === true && (await signInLocally()) ? 'in' : 'out');
      })
      .catch(() => setState('out'));
  }, []);

  async function submit(event) {
    event.preventDefault();
    setError(null);
    const response = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (response.ok) return setState('in');
    const problem = await response.json().catch(() => ({}));
    setError(problem.error ?? `could not ${mode}`);
  }

  if (state === 'in') return children;
  if (state === 'checking') return <div className="gate" />;

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <div className="gate-mark" />
        <h1 className="gate-title">Scope</h1>
        <p className="gate-sub">Your map stays on this machine.</p>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="email"
          autoComplete="username"
          required
        />
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="password"
          autoComplete="current-password"
          required
        />
        {error && <div className="gate-error">{error}</div>}
        <button type="submit">{mode === 'login' ? 'Open the map' : 'Create account'}</button>
        <button
          type="button"
          className="gate-switch"
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        >
          {mode === 'login' ? 'Create an account' : 'I already have an account'}
        </button>
      </form>
    </div>
  );
}
