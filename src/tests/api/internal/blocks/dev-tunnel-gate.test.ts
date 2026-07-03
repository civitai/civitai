import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { signDevTunnelAccessToken } from '~/server/services/blocks/dev-tunnel-session';

/**
 * APP DEV TUNNEL — coverage for the Traefik forwardAuth entry gate
 * `/api/internal/dev-tunnel-gate`. The gate protects the ENTRY DOCUMENT only: a
 * NAKED / expired / wrong-user / host-mismatched ENTRY request is DENIED (401),
 * so a visitor who knows the host cannot LOAD the dev page. Non-entry
 * subresources pass with no token (host-secrecy only — the accepted mod-gate.ts
 * tradeoff), so this suite pins the ENTRY-gate behaviour, not full protection.
 */

import handler from '~/pages/api/internal/dev-tunnel-gate';

const SECRET = 'test-nextauth-secret-cccccccccccccccccccc';
const HOST = 'dev-0123456789abcdef.civit.ai';
const USER = 99;

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

function makeReq(opts: { host?: string; uri?: string; secFetchDest?: string }): NextApiRequest {
  const headers: Record<string, string> = {};
  if (opts.host !== undefined) headers['x-forwarded-host'] = opts.host;
  if (opts.uri !== undefined) headers['x-forwarded-uri'] = opts.uri;
  if (opts.secFetchDest !== undefined) headers['sec-fetch-dest'] = opts.secFetchDest;
  return { method: 'GET', headers } as unknown as NextApiRequest;
}

const entryUri = (token: string) => `/?dev=${encodeURIComponent(token)}`;

describe('/api/internal/dev-tunnel-gate', () => {
  const prev = process.env.NEXTAUTH_SECRET;
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = SECRET;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = prev;
  });

  it('ENTRY (document) + valid dev token + matching host → 200 + X-Dev-User-Id', () => {
    const token = signDevTunnelAccessToken({ userId: USER, host: HOST, secret: SECRET });
    const res = makeRes();
    handler(makeReq({ host: HOST, uri: entryUri(token), secFetchDest: 'document' }), res);
    expect(res.statusCode).toBe(200);
    expect(res._headers['X-Dev-User-Id']).toBe(String(USER));
  });

  it('ENTRY (iframe) + valid token → 200', () => {
    const token = signDevTunnelAccessToken({ userId: USER, host: HOST, secret: SECRET });
    const res = makeRes();
    handler(makeReq({ host: HOST, uri: entryUri(token), secFetchDest: 'iframe' }), res);
    expect(res.statusCode).toBe(200);
  });

  // ── ENTRY-document gate: naked ENTRY denied (visitor can't LOAD the page) ──
  it('NAKED entry request (no dev token) → 401 (entry document gated)', () => {
    const res = makeRes();
    handler(makeReq({ host: HOST, uri: '/', secFetchDest: 'document' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('ABSENT Sec-Fetch-Dest is treated as ENTRY → still needs a token (naked → 401)', () => {
    const res = makeRes();
    handler(makeReq({ host: HOST, uri: '/' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('expired token → 401', () => {
    const token = signDevTunnelAccessToken({
      userId: USER,
      host: HOST,
      secret: SECRET,
      ttlSeconds: -1,
    });
    const res = makeRes();
    handler(makeReq({ host: HOST, uri: entryUri(token), secFetchDest: 'document' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('token bound to a DIFFERENT host (host mismatch) → 401', () => {
    const token = signDevTunnelAccessToken({
      userId: USER,
      host: 'dev-ffffffffffffffff.civit.ai',
      secret: SECRET,
    });
    const res = makeRes();
    handler(makeReq({ host: HOST, uri: entryUri(token), secFetchDest: 'document' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('token signed with a wrong secret (forged) → 401', () => {
    const token = signDevTunnelAccessToken({ userId: USER, host: HOST, secret: 'wrong-secret' });
    const res = makeRes();
    handler(makeReq({ host: HOST, uri: entryUri(token), secFetchDest: 'document' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('missing X-Forwarded-Host → 401 (fail-closed)', () => {
    const token = signDevTunnelAccessToken({ userId: USER, host: HOST, secret: SECRET });
    const res = makeRes();
    handler(makeReq({ uri: entryUri(token), secFetchDest: 'document' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('SUBRESOURCE (Sec-Fetch-Dest: script) → 200 (no token needed — accepted tradeoff)', () => {
    const res = makeRes();
    handler(makeReq({ host: HOST, uri: '/app.js', secFetchDest: 'script' }), res);
    expect(res.statusCode).toBe(200);
  });
});
