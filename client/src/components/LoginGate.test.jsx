import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoginGate from './LoginGate.jsx';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function serve(routes) {
  const fetchMock = vi.fn(async (url, init = {}) => {
    const answer = routes[`${init.method ?? 'GET'} ${url}`];
    return answer ? answer() : json(404, { error: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const called = (fetchMock, method, url) => fetchMock.mock.calls.some(([path, init = {}]) => path === url && (init.method ?? 'GET') === method);

afterEach(() => vi.unstubAllGlobals());

describe('LoginGate', () => {
  it('lets a signed-in browser straight through', async () => {
    const fetchMock = serve({ 'GET /api/auth/session': () => json(200, { userId: 'u1' }) });
    render(<LoginGate><p>the map</p></LoginGate>);
    expect(await screen.findByText('the map')).toBeInTheDocument();
    expect(called(fetchMock, 'POST', '/api/auth/local')).toBe(false);
  });

  it('never asks for local sign-in from an engine that does not offer it', async () => {
    const fetchMock = serve({ 'GET /api/auth/session': () => json(401, { error: 'not authenticated' }) });
    render(<LoginGate><p>the map</p></LoginGate>);
    expect(await screen.findByPlaceholderText('email')).toBeInTheDocument();
    expect(called(fetchMock, 'POST', '/api/auth/local')).toBe(false);
  });

  it('signs in locally when the engine offers it, with the custom header', async () => {
    const fetchMock = serve({
      'GET /api/auth/session': () => json(401, { error: 'not authenticated', localSignin: true }),
      'POST /api/auth/local': () => json(200, { id: 'u1', email: 'student@scope-demo.local' }),
    });
    render(<LoginGate><p>the map</p></LoginGate>);
    expect(await screen.findByText('the map')).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls.find(([path]) => path === '/api/auth/local');
    expect(init.headers['X-Scope-Local-Signin']).toBe('1');
  });

  it('shows the form when an offered local sign-in is refused', async () => {
    serve({
      'GET /api/auth/session': () => json(401, { error: 'not authenticated', localSignin: true }),
      'POST /api/auth/local': () => json(404, { error: 'local_signin_unavailable' }),
    });
    render(<LoginGate><p>the map</p></LoginGate>);
    expect(await screen.findByPlaceholderText('email')).toBeInTheDocument();
    expect(screen.queryByText('the map')).not.toBeInTheDocument();
  });
});
