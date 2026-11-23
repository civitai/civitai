import { json } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/axiom', () => ({
  logAxiomError: vi.fn(),
  logToAxiom: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/db/db', () => ({ db: {} }));

const { handle } = await import('../hooks.server');

function run(path: string, routeId: string | null, response: () => Response) {
  const url = new URL(path, 'https://auth.civitai.com');
  const event = {
    url,
    request: new Request(url, { headers: { 'sec-fetch-mode': 'navigate' } }),
    route: { id: routeId },
    cookies: { get: () => undefined, getAll: () => [], set: vi.fn(), delete: vi.fn() },
    locals: {},
  };
  return handle({ event, resolve: async () => response() } as never);
}

function expectNoFraming(res: Response) {
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
}

describe('every hub response refuses to be framed', () => {
  it('the login page', async () => {
    const res = await run(
      '/login',
      '/login',
      () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
    );
    expectNoFraming(res);
  });

  it('a JSON endpoint', async () => {
    const res = await run('/api/auth/jwks', '/api/auth/jwks', () => json({ keys: [] }));
    expectNoFraming(res);
    expect(await res.json()).toEqual({ keys: [] });
  });

  it('a redirect from a route', async () => {
    const res = await run(
      '/',
      '/',
      () => new Response(null, { status: 303, headers: { location: '/login' } })
    );
    expect(res.status).toBe(303);
    expectNoFraming(res);
  });

  it('a redirect with immutable headers', async () => {
    const res = await run('/', '/', () => Response.redirect('https://auth.civitai.com/login', 302));
    expect(res.headers.get('location')).toBe('https://auth.civitai.com/login');
    expectNoFraming(res);
  });

  it('a response the hook answers itself, without reaching the route', async () => {
    const res = await run('/admin', '/admin', () => new Response('unreachable'));
    expect(res.status).toBe(303);
    expectNoFraming(res);
  });

  it("keeps a route's own content-security-policy and adds frame-ancestors to it", async () => {
    const res = await run(
      '/login',
      '/login',
      () => new Response('', { headers: { 'content-security-policy': "default-src 'self'" } })
    );
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'self'; frame-ancestors 'none'"
    );
  });

  it("leaves a route's own frame-ancestors as it set it", async () => {
    const csp = "default-src 'self'; frame-ancestors https://example.com";
    const res = await run(
      '/login',
      '/login',
      () => new Response('', { headers: { 'content-security-policy': csp } })
    );
    expect(res.headers.get('content-security-policy')).toBe(csp);
  });
});
