import { describe, expect, it, vi, beforeEach } from 'vitest';
// Setup-order import: installs the ~/env/server mock with the real test RSA
// keypair BEFORE block-token.service / the middleware evaluate env at module
// load (same posture as block-scope.runtime-flag.test.ts).
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * "Any valid block token" mode — `withBlockScope(handler, {})` (no requiredScope).
 *
 * The block CATALOG endpoints (/api/v1/blocks/models, /api/v1/blocks/images)
 * serve PUBLIC, maturity-clamped data, so they require ANY valid block token
 * rather than a specific declarable scope (`catalog:read` was retired — it added
 * CLI-validator + per-app-allowedScopes friction with no security value). The
 * token is needed ONLY for its signed `maxBrowsingLevel` claim, not for authz.
 *
 * Asserted contract for the no-requiredScope mode:
 *   - a valid token that carries ZERO scopes (would 403 in scoped mode) is
 *     ACCEPTED — the per-scope check + enforceContextBinding are skipped.
 *   - FULL token validation is still enforced: an invalid token → 401.
 *   - a REVOKED instance is still rejected → 403 (revocation is independent of
 *     the scope gate).
 *   - the `private, no-store` cache header is still forced for the block JWT.
 *   - anon (no bearer) is NOT silently allowed: the wrapper falls through to the
 *     wrapped handler (whose own `if (!claims) 401` guard then rejects). There
 *     is no token to derive the maturity claim from.
 *
 * We mock ONLY the runtime flag (ON) + BlockRevocation (per-test), mirroring
 * block-scope.runtime-flag.test.ts. The token is minted by the REAL
 * BlockTokenService and run through the REAL middleware.
 */

const { isFliptMock } = vi.hoisted(() => ({
  // Runtime flag ON so the middleware verifies (not the dark fall-through path).
  isFliptMock: vi.fn(async (flag: string) =>
    flag === 'app-blocks-runtime-enabled' ? true : false
  ),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: isFliptMock }));

const { isRevokedMock } = vi.hoisted(() => ({ isRevokedMock: vi.fn(async () => false) }));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: isRevokedMock },
}));

import { withBlockScope } from '../block-scope.middleware';
import { BlockTokenService } from '~/server/services/block-token.service';

async function mintToken(scopes: string[]): Promise<string> {
  const r = await BlockTokenService.sign({
    userId: 42,
    blockId: 'blk_test',
    appId: 'app_test',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_test',
    scopes,
    ctx: { modelId: 1 },
    // The catalog endpoints read this claim; include it so the round-trip is
    // realistic (the middleware verifies its shape).
    maxBrowsingLevel: 3,
    domain: 'green',
  });
  return r.token;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send() {
      return this;
    },
    end() {
      return this;
    },
    setHeader(k: string, v: unknown) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    removeHeader() {
      return this;
    },
    writeHead() {
      return this;
    },
    getHeader(k: string) {
      return this.headers[k.toLowerCase()];
    },
    // Success path registers a fire-and-forget res.on('finish', …) logger; a
    // no-op registrar is enough (we don't invoke the DB-backed callback).
    on() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & {
    statusCode: number;
    body: unknown;
    headers: Record<string, unknown>;
  };
}

function makeReq(authHeader?: string): NextApiRequest {
  // No `origin` header → setBlockCors falls through to the flag/JWT logic.
  return {
    method: 'GET',
    headers: authHeader ? { authorization: authHeader } : {},
    query: {},
    url: '/api/v1/blocks/models',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

function makeReqWith(opts: {
  method?: string;
  origin?: string;
  authHeader?: string;
}): NextApiRequest {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.authHeader) headers.authorization = opts.authHeader;
  return {
    method: opts.method ?? 'GET',
    headers,
    query: {},
    url: '/api/v1/blocks/models',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

beforeEach(() => {
  isFliptMock.mockClear();
  isRevokedMock.mockClear();
  isRevokedMock.mockResolvedValue(false);
});

describe('withBlockScope — "any valid block token" mode (no requiredScope)', () => {
  it('accepts a valid token carrying ZERO scopes (per-scope gate + binding skipped)', async () => {
    const token = await mintToken([]); // would 403 in scoped mode
    const wrapped = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
      res.status(200).json({ via: 'block' });
    });
    const route = withBlockScope(wrapped as never, {}); // NO requiredScope

    const res = makeRes();
    await route(makeReq(`Bearer ${token}`) as never, res as never);

    expect(wrapped).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ via: 'block' });
    // The verified claims were attached (the middleware really validated it).
    // And the uncacheable header is still forced for a block JWT.
    expect(String(res.headers['cache-control'])).toContain('no-store');
  });

  it('still rejects an INVALID token → 401 (full validation preserved)', async () => {
    const wrapped = vi.fn();
    const route = withBlockScope(wrapped as never, {});

    // 3-segment JWS with a RS256/typ:JWT/kid header (passes isBlockJwt shape)
    // but a bogus signature → verifyBlockToken returns null → 401.
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'x' })
    ).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'user:1' })).toString('base64url');
    const bogus = `${header}.${payload}.bad`;

    const res = makeRes();
    await route(makeReq(`Bearer ${bogus}`) as never, res as never);

    expect(res.statusCode).toBe(401);
    expect(wrapped).not.toHaveBeenCalled();
  });

  it('still rejects a REVOKED instance → 403 (revocation independent of scope gate)', async () => {
    isRevokedMock.mockResolvedValue(true);
    const token = await mintToken([]);
    const wrapped = vi.fn();
    const route = withBlockScope(wrapped as never, {});

    const res = makeRes();
    await route(makeReq(`Bearer ${token}`) as never, res as never);

    expect(res.statusCode).toBe(403);
    expect(wrapped).not.toHaveBeenCalled();
  });

  it('anon (no bearer) falls through to the wrapped handler — never silently allowed', async () => {
    // The catalog endpoint's own `if (!claims) 401` guard then rejects. The
    // point: any-token mode does NOT allow anon (no token = no maturity claim).
    const wrapped = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
      res.status(401).json({ error: 'Block token required' });
    });
    const route = withBlockScope(wrapped as never, {});

    const res = makeRes();
    await route(makeReq() as never, res as never);

    expect(wrapped).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(401);
  });
});

describe('withBlockScope — opaque-origin CORS (allowOpaqueOrigin, catalog endpoints)', () => {
  it('answers the `Origin: null` PREFLIGHT with 204 + ACAO:null when opted in', async () => {
    // Unverified blocks run sandboxed without allow-same-origin → opaque origin
    // → the browser preflight carries `Origin: null`. The catalog endpoints opt
    // in, so the preflight is fully handled here (the wrapped handler — which
    // would 405 a non-GET — is never reached).
    const wrapped = vi.fn();
    const route = withBlockScope(wrapped as never, { allowOpaqueOrigin: true });

    const res = makeRes();
    await route(
      makeReqWith({ method: 'OPTIONS', origin: 'null' }) as never,
      res as never
    );

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('null');
    expect(String(res.headers['access-control-allow-methods'])).toContain('GET');
    expect(wrapped).not.toHaveBeenCalled();
  });

  it('the actual GET from `Origin: null` carries ACAO:null + still requires a valid token', async () => {
    const token = await mintToken([]);
    const wrapped = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
      res.status(200).json({ via: 'block' });
    });
    const route = withBlockScope(wrapped as never, { allowOpaqueOrigin: true });

    const res = makeRes();
    await route(
      makeReqWith({ method: 'GET', origin: 'null', authHeader: `Bearer ${token}` }) as never,
      res as never
    );

    // The GET ran (token validated) AND the response is readable cross-origin.
    expect(wrapped).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('null');
  });

  it('a `Origin: null` GET with NO/invalid token is still 401 — the preflight is policy, the token is the gate', async () => {
    const wrapped = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
      res.status(401).json({ error: 'Block token required' });
    });
    const route = withBlockScope(wrapped as never, { allowOpaqueOrigin: true });

    const res = makeRes();
    // No Authorization header → falls through to the wrapped handler's 401 guard.
    await route(makeReqWith({ method: 'GET', origin: 'null' }) as never, res as never);

    expect(res.statusCode).toBe(401);
    // ACAO:null is still set so the browser can READ the 401 (not a CORS error).
    expect(res.headers['access-control-allow-origin']).toBe('null');
  });

  it('does NOT honor `Origin: null` when the endpoint did NOT opt in (scoped/credentialed routes)', async () => {
    // A scoped route (or any route without allowOpaqueOrigin) must NEVER echo
    // ACAO:null — that would let any sandboxed page read a per-user response.
    const wrapped = vi.fn();
    const route = withBlockScope(wrapped as never, { requiredScope: 'models:read:self' });

    const res = makeRes();
    await route(
      makeReqWith({ method: 'OPTIONS', origin: 'null' }) as never,
      res as never
    );

    // setBlockCors returned 'fallthrough' (no ACAO set); the preflight was NOT
    // answered here. The wrapped handler (real catalog/route) would 405 it.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('the opt-in does NOT widen to arbitrary real origins — only the literal `null` is special-cased', async () => {
    const wrapped = vi.fn();
    const route = withBlockScope(wrapped as never, { allowOpaqueOrigin: true });

    const res = makeRes();
    await route(
      makeReqWith({ method: 'OPTIONS', origin: 'https://evil.example' }) as never,
      res as never
    );

    // A non-allowlisted, non-null origin gets no ACAO — opaque handling is
    // strictly scoped to `Origin: null`.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
