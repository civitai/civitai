import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// Handler test lives OUTSIDE src/pages (Next would treat it as a route), imported via the ~/pages alias.
// /api/auth/login-popup builds the POPUP login URL on the MAIN SERVER (server AUTH_JWT_ISSUER, no client hub
// var); its post-login dest is the same-origin /login/popup-done page that signals the opener.

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

describe('/api/auth/login-popup', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.AUTH_JWT_ISSUER = 'https://auth.test';
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('302s to a server-built hub login URL that routes back through this spoke to /login/popup-done', async () => {
    const handler = (await import('~/pages/api/auth/login-popup')).default;
    const { req, res } = mockReqRes({ cb: '/models/1', reason: 'image-gen' });
    handler(req, res as unknown as NextApiResponse);

    expect(res.statusCode).toBe(302);
    const url = new URL(res.location as string);
    expect(url.origin).toBe('https://auth.test');
    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('reason')).toBe('image-gen');
    // The nested returnUrl chain lands on the same-origin popup-done page (carrying the cb).
    expect(res.location).toContain('popup-done');
    expect(decodeURIComponent(res.location as string)).toContain(
      'https://civitai.com/api/auth/authorize'
    );
  });

  it('500 when the hub is not configured', async () => {
    delete process.env.AUTH_JWT_ISSUER;
    vi.resetModules();
    const handler = (await import('~/pages/api/auth/login-popup')).default;
    const { req, res } = mockReqRes({ cb: '/' });
    handler(req, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(500);
  });
});
