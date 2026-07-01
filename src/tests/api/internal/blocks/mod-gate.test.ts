import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  signReviewAccessToken,
  signReviewSessionCookie,
} from '~/server/services/blocks/review-session';

/**
 * MOD REVIEW SANDBOX (#2831 / #2847) — coverage for the Traefik forwardAuth
 * target /api/internal/mod-gate, now a FULL SUBRESOURCE GATE (CHIPS session
 * cookie), not just an entry gate.
 *
 *   - SESSION COOKIE (valid) → 200 + X-Mod-Id for ANY dest (incl. subresource)
 *   - ENTRY (document/iframe/absent) + valid mr + matching host → 200 + X-Mod-Id
 *     AND Set-Cookie present (__Host- + Partitioned + SameSite=None + Secure)
 *   - SUBRESOURCE (Sec-Fetch-Dest: image/script) with NO cookie → 401  ← spoof hole closed
 *   - ENTRY + missing / expired / forged / host-mismatched mr → 401
 *   - INVALID/expired session cookie → falls through to entry/token logic
 *   - missing X-Forwarded-Host → 401 (fail-closed)
 *
 * The handler is driven directly with mock req/res. The token + cookie utils are
 * REAL (signed with an injected secret via process.env.NEXTAUTH_SECRET).
 */

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));

import handler from '~/pages/api/internal/mod-gate';

const SECRET = 'test-nextauth-secret-bbbbbbbbbbbbbbbbbbbb';
const HOST = 'review-0123456789abcdef.civit.ai';
const MOD = 77;

function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    _headers: headers,
  };
  return res as unknown as NextApiResponse & {
    statusCode: number;
    body: unknown;
    _headers: Record<string, string>;
  };
}

function makeReq(opts: {
  host?: string;
  uri?: string;
  secFetchDest?: string;
  cookie?: string;
}): NextApiRequest {
  const headers: Record<string, string> = {};
  if (opts.host !== undefined) headers['x-forwarded-host'] = opts.host;
  if (opts.uri !== undefined) headers['x-forwarded-uri'] = opts.uri;
  if (opts.secFetchDest !== undefined) headers['sec-fetch-dest'] = opts.secFetchDest;
  if (opts.cookie !== undefined) headers['cookie'] = opts.cookie;
  return { method: 'GET', headers } as unknown as NextApiRequest;
}

function entryUriWithToken(token: string): string {
  return `/some-slug?mr=${encodeURIComponent(token)}`;
}

function sessionCookieHeader(value: string): string {
  return `__Host-review-sess=${value}`;
}

describe('/api/internal/mod-gate (full subresource gate)', () => {
  const prev = process.env.NEXTAUTH_SECRET;
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = SECRET;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = prev;
    vi.clearAllMocks();
  });

  // ── SESSION COOKIE path (gates subresources) ──────────────────────────────

  it('SESSION cookie (valid) + matching host → 200 for a SUBRESOURCE (script)', async () => {
    const cookie = signReviewSessionCookie({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({
        host: HOST,
        uri: '/assets/index.js',
        secFetchDest: 'script',
        cookie: sessionCookieHeader(cookie),
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res._headers['X-Mod-Id']).toBe(String(MOD));
  });

  it('SESSION cookie (valid) → 200 for an IMAGE subresource (the previously spoofable dest)', async () => {
    const cookie = signReviewSessionCookie({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({
        host: HOST,
        uri: '/assets/logo.png',
        secFetchDest: 'image',
        cookie: sessionCookieHeader(cookie),
      }),
      res
    );
    expect(res.statusCode).toBe(200);
  });

  it('SESSION cookie bound to a DIFFERENT host → not honoured (falls through, subresource → 401)', async () => {
    const cookie = signReviewSessionCookie({
      modUserId: MOD,
      host: 'review-deadbeefdeadbeef.civit.ai',
      secret: SECRET,
    });
    const res = makeRes();
    await handler(
      makeReq({
        host: HOST,
        uri: '/assets/index.js',
        secFetchDest: 'script',
        cookie: sessionCookieHeader(cookie),
      }),
      res
    );
    expect(res.statusCode).toBe(401);
  });

  // ── THE CLOSED SPOOF HOLE ─────────────────────────────────────────────────

  it('SUBRESOURCE (Sec-Fetch-Dest: image) with NO cookie/token → 401 (spoof hole closed)', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/logo.png', secFetchDest: 'image' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('SUBRESOURCE (Sec-Fetch-Dest: script) with NO cookie/token → 401', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/index.js', secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('SUBRESOURCE (Sec-Fetch-Dest: empty / XHR) with NO cookie → 401', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/api/x', secFetchDest: 'empty' }), res);
    expect(res.statusCode).toBe(401);
  });

  // ── ENTRY path (mints the session cookie) ─────────────────────────────────

  it('ENTRY (document) + valid mr + matching host → 200 + X-Mod-Id AND Set-Cookie (CHIPS)', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'document' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res._headers['X-Mod-Id']).toBe(String(MOD));
    const setCookie = res._headers['Set-Cookie'];
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('__Host-review-sess=');
    expect(setCookie).toContain('Partitioned');
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=1800');
    expect(setCookie).not.toContain('Domain=');
  });

  it('ENTRY (iframe) with a valid mr token → 200 + Set-Cookie', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'iframe' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res._headers['Set-Cookie']).toContain('Partitioned');
  });

  it('ENTRY with NO mr token → 401', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/some-slug', secFetchDest: 'document' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('ENTRY with an EXPIRED mr token → 401', async () => {
    const token = signReviewAccessToken({
      modUserId: MOD,
      host: HOST,
      secret: SECRET,
      ttlSeconds: -1,
    });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'document' }),
      res
    );
    expect(res.statusCode).toBe(401);
  });

  it('ENTRY with a FORGED mr token (wrong secret) → 401', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: 'wrong-secret' });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'document' }),
      res
    );
    expect(res.statusCode).toBe(401);
  });

  it('ENTRY with a token bound to a DIFFERENT host → 401', async () => {
    const token = signReviewAccessToken({
      modUserId: MOD,
      host: 'review-deadbeefdeadbeef.civit.ai',
      secret: SECRET,
    });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'document' }),
      res
    );
    expect(res.statusCode).toBe(401);
  });

  it('ABSENT Sec-Fetch-Dest is treated as ENTRY → needs a token (401 without one)', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/some-slug' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('ABSENT Sec-Fetch-Dest WITH a valid token → 200 + Set-Cookie (entry path satisfied)', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: entryUriWithToken(token) }), res);
    expect(res.statusCode).toBe(200);
    expect(res._headers['X-Mod-Id']).toBe(String(MOD));
    expect(res._headers['Set-Cookie']).toContain('Partitioned');
  });

  // ── invalid/expired cookie falls through to entry/token logic ─────────────

  it('INVALID session cookie + valid ENTRY token → 200 (re-establishes via token) + Set-Cookie', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({
        host: HOST,
        uri: entryUriWithToken(token),
        secFetchDest: 'document',
        cookie: sessionCookieHeader('garbage.value'),
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res._headers['Set-Cookie']).toContain('Partitioned');
  });

  it('EXPIRED session cookie on a SUBRESOURCE (no token) → 401 (no entry fallback for subresources)', async () => {
    const expired = signReviewSessionCookie({
      modUserId: MOD,
      host: HOST,
      secret: SECRET,
      ttlSeconds: -1,
    });
    const res = makeRes();
    await handler(
      makeReq({
        host: HOST,
        uri: '/assets/index.js',
        secFetchDest: 'script',
        cookie: sessionCookieHeader(expired),
      }),
      res
    );
    expect(res.statusCode).toBe(401);
  });

  it('an `mr` ENTRY token presented as the SESSION cookie is REJECTED (domain separation)', async () => {
    // Attacker captures the 120s entry token and tries to use it as the long-lived
    // subresource cookie. Must NOT authorize a subresource.
    const entry = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({
        host: HOST,
        uri: '/assets/index.js',
        secFetchDest: 'script',
        cookie: sessionCookieHeader(entry),
      }),
      res
    );
    expect(res.statusCode).toBe(401);
  });

  it('valid SESSION cookie but MISSING X-Forwarded-Host → 401 (fail-closed)', async () => {
    const cookie = signReviewSessionCookie({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({ uri: '/assets/index.js', secFetchDest: 'script', cookie: sessionCookieHeader(cookie) }),
      res
    );
    expect(res.statusCode).toBe(401);
  });

  it('valid ENTRY token but MISSING X-Forwarded-Host → 401 (fail-closed)', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(makeReq({ uri: entryUriWithToken(token), secFetchDest: 'document' }), res);
    expect(res.statusCode).toBe(401);
  });
});
