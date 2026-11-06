import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The hub's session-acting POSTs accept only the callers they have: hub pages for the device and consent
 * steps, plus allowlisted spokes and header-less server calls for switch, impersonate, account removal
 * and logout.
 */

vi.hoisted(() => {
  process.env.AUTH_CORS_ORIGINS = 'https://moderator.civitai.com';
});
vi.mock('$lib/server/axiom', () => ({ logAxiomError: vi.fn(), logToAxiom: vi.fn() }));
vi.mock('$lib/server/auth/session-producer', () => ({ getOrProduceSessionUser: vi.fn() }));

import { handle } from '../hooks.server';

const HUB = 'https://auth.civitai.com';
const resolve = vi.fn(async () => new Response('handled'));

function post(routeId: string, headers: Record<string, string> = {}, method = 'POST') {
  const url = new URL(`${HUB}${routeId}`);
  return handle({
    event: {
      url,
      route: { id: routeId },
      request: new Request(url, { method, headers }),
      cookies: { get: () => undefined },
      locals: {},
    },
    resolve,
  } as never) as Promise<Response>;
}

beforeEach(() => resolve.mockClear());

describe('hub-page-only routes', () => {
  const routes = [
    '/api/auth/oauth/device-approve',
    '/api/auth/oauth/device-deny',
    '/login/oauth/device',
    '/login/oauth/authorize',
  ];

  it.each(routes)('%s refuses a POST from another origin', async (route) => {
    const res = await post(route, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(routes)('%s refuses a POST naming no origin', async (route) => {
    const res = await post(route);
    expect(res.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses a same-site sibling and an opaque origin', async () => {
    expect((await post(routes[0], { origin: 'https://civitai.com' })).status).toBe(403);
    expect((await post(routes[0], { origin: 'null' })).status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(routes)('%s accepts a POST from a hub page (positive control)', async (route) => {
    const res = await post(route, { origin: HUB });
    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('falls back to the Referer when Origin is absent', async () => {
    expect((await post(routes[0], { referer: `${HUB}/login/oauth/device` })).status).toBe(200);
    expect((await post(routes[0], { referer: 'https://evil.example/x' })).status).toBe(403);
  });

  it('leaves GET alone', async () => {
    const res = await post('/login/oauth/device', { origin: 'https://evil.example' }, 'GET');
    expect(res.status).toBe(200);
  });
});

describe('switch, impersonate, account removal and logout', () => {
  const routes = [
    '/api/auth/switch',
    '/api/auth/impersonate',
    '/api/auth/impersonate/exit',
    '/logout',
  ];

  it.each(routes)('%s refuses a POST from another origin', async (route) => {
    const res = await post(route, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('leaves the GET /logout landing page open to cross-site spokes', async () => {
    expect((await post('/logout', { origin: 'https://civitai.red' }, 'GET')).status).toBe(200);
  });

  it.each(routes)('%s refuses an opaque origin', async (route) => {
    expect((await post(route, { origin: 'null' })).status).toBe(403);
  });

  // Decision: the main-app and creator-studio proxies call these server-to-server with the user's cookie and
  // send neither Origin nor Referer. Refusing the header-less case breaks account switching and impersonation,
  // and stops the main app's logout from revoking the hub session.
  it.each(routes)('%s accepts the header-less server proxy call', async (route) => {
    expect((await post(route)).status).toBe(200);
  });

  it.each(routes)('%s accepts a hub page and an allowlisted spoke', async (route) => {
    expect((await post(route, { origin: HUB })).status).toBe(200);
    expect((await post(route, { origin: 'https://moderator.civitai.com' })).status).toBe(200);
  });

  it('applies the same rule to removing an account', async () => {
    const del = (headers: Record<string, string> = {}) =>
      post('/api/auth/accounts', headers, 'DELETE');
    expect((await del({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await del({ origin: 'null' })).status).toBe(403);
    expect((await del()).status).toBe(200);
    expect((await del({ origin: HUB })).status).toBe(200);
  });
});
