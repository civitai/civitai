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
    // returnUrl is made absolute + same-origin from the request host (the hub returns here after linking).
    expect(url.searchParams.get('returnUrl')).toBe('https://civitai.com/user/account#accounts');
  });

  it('collapses an unsafe returnUrl to the origin root (no open redirect)', async () => {
    const handler = (await import('~/pages/api/auth/connect')).default;
    const { req, res } = mockReqRes({ provider: 'github', returnUrl: 'https://evil.com' });
    handler(req, res as unknown as NextApiResponse);
    expect(new URL(res.location as string).searchParams.get('returnUrl')).toBe(
      'https://civitai.com/'
    );
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
