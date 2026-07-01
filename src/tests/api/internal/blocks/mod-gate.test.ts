import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { signReviewAccessToken } from '~/server/services/blocks/review-session';

/**
 * MOD REVIEW SANDBOX (#2831 / #2847 / #2855) — coverage for the Traefik
 * forwardAuth target /api/internal/mod-gate, now an ENTRY-GATE-ONLY gate.
 *
 * The CHIPS subresource-cookie gate was reverted: Traefik forwardAuth does not
 * forward a 2xx auth response's Set-Cookie back to the client, so the session
 * cookie could never be set (every subresource 401'd → preview never rendered).
 *
 *   - ENTRY (document/iframe/frame/nested-document/absent) + valid mr + matching
 *     host → 200 + X-Mod-Id (NO Set-Cookie)
 *   - ENTRY + missing / expired / forged / host-mismatched mr → 401
 *   - ABSENT Sec-Fetch-Dest → treated as ENTRY → needs a token (401 without one)
 *   - SUBRESOURCE (Sec-Fetch-Dest: image/script/empty) → 200 (no token/cookie needed)
 *   - missing X-Forwarded-Host → 401 (fail-closed)
 *
 * The handler is driven directly with mock req/res. The token util is REAL
 * (signed with an injected secret via process.env.NEXTAUTH_SECRET).
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

describe('/api/internal/mod-gate (entry-gate-only)', () => {
  const prev = process.env.NEXTAUTH_SECRET;
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = SECRET;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = prev;
    vi.clearAllMocks();
  });

  // ── ENTRY path (requires a valid mr token) ────────────────────────────────

  it('ENTRY (document) + valid mr + matching host → 200 + X-Mod-Id, NO Set-Cookie', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'document' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res._headers['X-Mod-Id']).toBe(String(MOD));
    expect(res._headers['Set-Cookie']).toBeUndefined();
  });

  it('ENTRY (iframe) with a valid mr token → 200 + X-Mod-Id', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'iframe' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res._headers['X-Mod-Id']).toBe(String(MOD));
    expect(res._headers['Set-Cookie']).toBeUndefined();
  });

  it('ENTRY (nested-document) with a valid mr token → 200', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(
      makeReq({ host: HOST, uri: entryUriWithToken(token), secFetchDest: 'nested-document' }),
      res
    );
    expect(res.statusCode).toBe(200);
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

  // ── ABSENT Sec-Fetch-Dest → treated as ENTRY (fail-safe) ──────────────────

  it('ABSENT Sec-Fetch-Dest is treated as ENTRY → needs a token (401 without one)', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/some-slug' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('ABSENT Sec-Fetch-Dest WITH a valid token → 200 + X-Mod-Id', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: entryUriWithToken(token) }), res);
    expect(res.statusCode).toBe(200);
    expect(res._headers['X-Mod-Id']).toBe(String(MOD));
    expect(res._headers['Set-Cookie']).toBeUndefined();
  });

  // ── SUBRESOURCE path (allowed without any token/cookie) ───────────────────

  it('SUBRESOURCE (Sec-Fetch-Dest: script) → 200 (no token/cookie needed)', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/index.js', secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(200);
    expect(res._headers['Set-Cookie']).toBeUndefined();
  });

  it('SUBRESOURCE (Sec-Fetch-Dest: image) → 200 (no token/cookie needed)', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/logo.png', secFetchDest: 'image' }), res);
    expect(res.statusCode).toBe(200);
  });

  it('SUBRESOURCE (Sec-Fetch-Dest: empty / XHR) → 200', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/api/x', secFetchDest: 'empty' }), res);
    expect(res.statusCode).toBe(200);
  });

  it('SUBRESOURCE (Sec-Fetch-Dest: font) → 200', async () => {
    const res = makeRes();
    await handler(makeReq({ host: HOST, uri: '/assets/font.woff2', secFetchDest: 'font' }), res);
    expect(res.statusCode).toBe(200);
  });

  // ── fail-closed on missing host ───────────────────────────────────────────

  it('ENTRY: valid token but MISSING X-Forwarded-Host → 401 (fail-closed)', async () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const res = makeRes();
    await handler(makeReq({ uri: entryUriWithToken(token), secFetchDest: 'document' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('SUBRESOURCE: MISSING X-Forwarded-Host → 401 (fail-closed, checked before subresource allow)', async () => {
    const res = makeRes();
    await handler(makeReq({ uri: '/assets/index.js', secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(401);
  });
});
