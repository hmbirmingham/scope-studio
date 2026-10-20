// The browser page a local engine opens for sign-in. Server-rendered, with
// its CSS and script inline and nothing loaded from anywhere else, so the
// page that handles a password has no third-party code on it. Desktop layout
// only for now: the engine that opens it is the desktop app.

// Every value that came from the query string goes through this before it
// reaches the page, whether in text or in an attribute.
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Sent with the page: the inline script runs only with this request's nonce,
// fetches go only to this origin, and the page cannot be framed.
export function signinPageCsp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0b0b0d; color: #d8d8dc; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { width: 760px; padding: 40px; background: #121215; border: 1px solid #232328; border-radius: 14px; }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; color: #f2f2f4; }
  .lede { margin: 0 0 28px; color: #8c8c94; }
  .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
  h2 { margin: 0 0 14px; font-size: 15px; font-weight: 600; color: #f2f2f4; }
  label { display: block; margin-bottom: 12px; color: #8c8c94; font-size: 13px; }
  input[type=email], input[type=password] { display: block; width: 100%; margin-top: 4px; padding: 9px 11px;
    background: #0b0b0d; color: #f2f2f4; border: 1px solid #2c2c32; border-radius: 8px; font: inherit; }
  input:focus { outline: none; border-color: #7aa2ff; }
  button { margin-top: 4px; padding: 9px 16px; background: #1d1d22; color: #f2f2f4; border: 1px solid #34343b;
    border-radius: 8px; font: inherit; cursor: pointer; }
  button:hover, button:focus { border-color: #7aa2ff; outline: none; }
  button:disabled { opacity: 0.5; cursor: default; }
  .dev { display: flex; gap: 10px; align-items: flex-start; margin: 28px 0 0; padding-top: 20px; border-top: 1px solid #232328; }
  .dev input { margin-top: 4px; accent-color: #7aa2ff; }
  .dev span { color: #8c8c94; font-size: 13px; }
  .dev strong { color: #d8d8dc; font-weight: 600; }
  #status { min-height: 22px; margin: 20px 0 0; color: #8c8c94; }
  #status.error { color: #ff8f8f; }
`;

const SCRIPT = `
  const $ = (id) => document.getElementById(id);
  const engine = {
    redirect_uri: $('redirect_uri').value,
    state: $('state').value,
    code_challenge: $('code_challenge').value,
    code_challenge_method: 'S256',
    label: $('label').value,
  };

  // Text only, never markup: server error sentences are shown as they are.
  function status(message, isError) {
    $('status').textContent = message;
    $('status').className = isError ? 'error' : '';
  }

  async function post(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await response.json(); } catch {}
    return { ok: response.ok, data };
  }

  async function submit(form, path) {
    const buttons = document.querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    try {
      status('Signing in...');
      const login = await post(path, {
        email: form.elements.email.value,
        password: form.elements.password.value,
        dev_mode: $('dev_mode').checked,
      });
      if (!login.ok) return status(login.data.error || 'Sign-in failed. Try again.', true);
      if (!engine.redirect_uri) return status('Signed in as ' + login.data.email + '. You can close this tab.');

      const authorized = await post('/v1/auth/authorize', engine);
      if (!authorized.ok) return status(authorized.data.error || 'Could not finish signing in. Start again from the app.', true);
      status('Returning to Scope Studio...');
      window.location.assign(authorized.data.redirect);
    } catch {
      status('Could not reach Scope Studio. Check your connection and try again.', true);
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  $('signin').addEventListener('submit', (event) => { event.preventDefault(); submit(event.target, '/v1/auth/login'); });
  $('register').addEventListener('submit', (event) => { event.preventDefault(); submit(event.target, '/v1/accounts'); });
`;

function layout({ nonce, title, body, script = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style nonce="${escapeHtml(nonce)}">${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
${script ? `<script nonce="${escapeHtml(nonce)}">${script}</script>` : ''}
</body>
</html>`;
}

// The sign-in and register forms. `engine` holds the loopback hand-off
// parameters, already validated by the route; they ride along as hidden
// fields and are sent to /v1/auth/authorize once the person is signed in.
export function renderSigninPage({ nonce, engine = {} }) {
  const hidden = ['redirect_uri', 'state', 'code_challenge', 'label']
    .map((name) => `<input type="hidden" id="${name}" value="${escapeHtml(engine[name])}">`)
    .join('\n');
  const lede = engine.redirect_uri
    ? engine.label
      ? `Sign in to connect <strong>${escapeHtml(engine.label)}</strong> to your account.`
      : 'Sign in to connect this device to your account.'
    : 'Sign in to your account.';

  const body = `
<h1>Scope Studio</h1>
<p class="lede">${lede}</p>
${hidden}
<div class="columns">
  <form id="signin" autocomplete="on">
    <h2>Sign in</h2>
    <label>Email <input type="email" name="email" autocomplete="username" required></label>
    <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
    <button type="submit">Sign in</button>
  </form>
  <form id="register" autocomplete="on">
    <h2>Create an account</h2>
    <label>Email <input type="email" name="email" autocomplete="username" required></label>
    <label>Password (at least 10 characters) <input type="password" name="password" autocomplete="new-password" minlength="10" required></label>
    <button type="submit">Create account</button>
  </form>
</div>
<label class="dev">
  <input type="checkbox" id="dev_mode">
  <span><strong>Developer sign-in.</strong> For allowlisted developer emails only: this device gets the Engineer plan
  without a subscription, and the sign-in is recorded and reported.</span>
</label>
<p id="status" role="status" aria-live="polite"></p>`;

  return layout({ nonce, title: 'Sign in - Scope Studio', body, script: SCRIPT });
}

// Shown instead of the forms when the link that opened the page is broken or
// was not made by a Scope Studio engine, so nothing is signed in for it.
export function renderSigninError({ nonce, message }) {
  const body = `
<h1>Scope Studio</h1>
<p class="lede">${escapeHtml(message)}</p>
<p>Start signing in again from the Scope Studio app.</p>`;
  return layout({ nonce, title: 'Sign-in link not valid - Scope Studio', body });
}
