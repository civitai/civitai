import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// Handler test lives OUTSIDE src/pages (Next would treat it as a route) and imports via the ~/pages alias.
// /api/auth/connect builds the hub account-LINK URL on the MAIN SERVER (server AUTH_JWT_ISSUER) — no client
// hub env var — and 302s to it.

const ORIGINAL_ENV = { ...process.env };

function mockReqRes(query: Record<string, string>, host = 'civitai.com') {
  const res = {
    statusCode: 200 as number,
    body: undefined as unknown,
    location: undefined as string | undefined,
    headers: {} as Record<string, unknown>,
    getHeader(name: string) {
      return this.headers[name];
    },
    setHeader(name: string, value: unknown) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    redirect(code: number, loc: string) {
      this.statusCode = code;
      this.location = loc;
      return this;
    },
  };
  const req = { query, headers: { host } } as unknown as NextApiRequest;
  return { req, res };
}

describe('/api/auth/connect', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.AUTH_JWT_ISSUER = 'https://auth.test';
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('302s to the hub link URL built from the server AUTH_JWT_ISSUER (no client hub var)', async () => {
    const handler = (await import('~/pages/api/auth/connect')).default;
    const { req, res } = mockReqRes({ provider: 'discord', returnUrl: '/user/account#accounts' });
    handler(req, res as unknown as NextApiResponse);

    expect(res.statusCode).toBe(302);
    const url = new URL(res.location as string);
    expect(url.origin + url.pathname).toBe('https://auth.test/login/discord');
    expect(url.searchParams.get('link')).toBe('true');
    // The hub returns to /api/auth/linked (absolute + same-origin from the request host) so the main app can run
    // its post-link side effects, carrying the caller's path along for the forward.
    const returned = new URL(url.searchParams.get('returnUrl') as string);
    expect(returned.origin + returned.pathname).toBe('https://civitai.com/api/auth/linked');
    expect(returned.searchParams.get('provider')).toBe('discord');
    expect(returned.searchParams.get('returnUrl')).toBe('/user/account#accounts');
  });

  it('collapses an unsafe returnUrl to the origin root (no open redirect)', async () => {
    const handler = (await import('~/pages/api/auth/connect')).default;
    const { req, res } = mockReqRes({ provider: 'github', returnUrl: 'https://evil.com' });
    handler(req, res as unknown as NextApiResponse);
    const returned = new URL(
      new URL(res.location as string).searchParams.get('returnUrl') as string
    );
    expect(returned.origin + returned.pathname).toBe('https://civitai.com/api/auth/linked');
    expect(returned.searchParams.get('returnUrl')).toBe('/');
  });

  // The other half of the one-shot protocol /api/auth/linked gates on. Asserted here by NAME and PATH, because
  // the linked-endpoint test supplies its own cookie fixture — without this, deleting the call below leaves
  // every test in both files green while the post-link sync is dead in production.
  it('sets the one-shot link cookie that /api/auth/linked consumes', async () => {
    const handler = (await import('~/pages/api/auth/connect')).default;
    const { req, res } = mockReqRes({ provider: 'discord', returnUrl: '/user/account' });
    handler(req, res as unknown as NextApiResponse);

    const cookies = res.headers['Set-Cookie'] as string[];
    const cookie = cookies.find((c) => c.startsWith('civ-link-sync='));
    expect(cookie).toBeDefined();
    expect(cookie).toContain('Path=/api/auth/linked');
    expect(cookie).toContain('HttpOnly');
  });

  // Plain http in tests means the dev branch: None-without-Secure is browser-rejected, so it has to be Lax.
  // On https the cookie rides a cross-registrable-domain return (civitai.red → hub → civitai.red), where Lax
  // and host-only scoping are both known to drop it — see the bridge cookie this mirrors.
  it('scopes the cookie for the cross-site return when the request is https', async () => {
    const handler = (await import('~/pages/api/auth/connect')).default;
    const { req, res } = mockReqRes({ provider: 'discord', returnUrl: '/' }, 'www.civitai.red');
    (req.headers as Record<string, string>)['x-forwarded-proto'] = 'https';
    handler(req, res as unknown as NextApiResponse);

    const cookie = (res.headers['Set-Cookie'] as string[]).find((c) =>
      c.startsWith('civ-link-sync=')
    ) as string;
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Domain=civitai.red');
  });

  it('400 when provider is missing', async () => {
    const handler = (await import('~/pages/api/auth/connect')).default;
    const { req, res } = mockReqRes({});
    handler(req, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(400);
  });

  it('500 when the hub is not configured', async () => {
    delete process.env.AUTH_JWT_ISSUER;
    vi.resetModules();
    const handler = (await import('~/pages/api/auth/connect')).default;
    const { req, res } = mockReqRes({ provider: 'discord' });
    handler(req, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(500);
  });
});
