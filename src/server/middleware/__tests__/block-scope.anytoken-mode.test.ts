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
