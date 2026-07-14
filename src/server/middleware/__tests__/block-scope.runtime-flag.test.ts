import { describe, expect, it, vi, beforeEach } from 'vitest';
// Setup-order import: installs the ~/env/server mock with the real test RSA
// keypair BEFORE block-token.service / the middleware evaluate env at module
// load (same posture as block-scope.middleware.test.ts).
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Decision 4 — withBlockScope runtime gate (end-to-end).
 *
 * `withBlockScope` verifies an already-minted block JWT on scoped REST calls.
 * After Decision 4 it gates on the dedicated GLOBAL `app-blocks-runtime-enabled`
 * flag (NOT the mod-segmented `app-blocks-enabled` user flag, whose global eval
 * is always false → verification was permanently dark).
 *
 * These tests mint a REAL, otherwise-VALID block JWT (via BlockTokenService,
 * signed with the test RSA key from ~/__tests__/setup) and drive it through the
 * REAL middleware. We mock ONLY:
 *   - `~/server/flipt/client.isFlipt` (per-key) — to flip the runtime flag, and
 *   - `BlockRevocation.isRevoked` → false — so a valid token isn't rejected for
 *     an unrelated reason (we're testing the flag gate, not revocation).
 *
 * Asserted contract:
 *   - flag OFF / absent → the middleware treats the present, valid block JWT as
 *     ABSENT: it FALLS THROUGH to the wrapped (legacy-auth) handler, never sets
 *     `req.blockClaims`, never 401s. (The exact prior dark behaviour.)
 *   - flag ON → the middleware VERIFIES the JWT and GRANTS the scoped context:
 *     `req.blockClaims` is populated with the minted claims and the wrapped
 *     handler runs WITH block scope. (Non-vacuous: we assert the claims, not
 *     merely the absence of a 503.)
 *   - the middleware reads the LITERAL 'app-blocks-runtime-enabled' key and
 *     NEVER 'app-blocks-enabled' (no accidental repoint / widening).
 */

const { mockFlipt, isFliptMock } = vi.hoisted(() => {
  const mockFlipt = { runtime: false, user: false };
  return {
    mockFlipt,
    // Per-key Flipt stand-in: runtime key reflects mockFlipt.runtime, user key
    // reflects mockFlipt.user. Proves the USER flag being on does NOT enable
    // verification, and that the middleware only ever reads the runtime key.
    isFliptMock: vi.fn(async (flag: string) => {
      if (flag === 'app-blocks-runtime-enabled') return mockFlipt.runtime;
      if (flag === 'app-blocks-enabled') return mockFlipt.user;
      return false;
    }),
  };
});
vi.mock('~/server/flipt/client', () => ({ isFlipt: isFliptMock }));

// Don't reject the valid token for revocation — we're isolating the flag gate.
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: vi.fn(async () => false) },
}));

import { withBlockScope, type BlockScopedNextApiRequest } from '../block-scope.middleware';
import { BlockTokenService } from '~/server/services/block-token.service';

const MODEL_ID = 12345;
const REQUIRED_SCOPE = 'models:read:self';

async function mintValidToken(): Promise<string> {
  const r = await BlockTokenService.sign({
    userId: 42,
    blockId: 'blk_test',
    appId: 'app_test',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_test',
    scopes: [REQUIRED_SCOPE],
    // models:read:self binds ctx.modelId against the query `id` (see
    // enforceContextBinding). Match them so a flag-ON request reaches grant.
    ctx: { modelId: MODEL_ID },
  });
  return r.token;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
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
    setHeader() {
      return this;
    },
    removeHeader() {
      return this;
    },
    writeHead() {
      return this;
    },
    getHeader() {
      return undefined;
    },
    // The success path registers a fire-and-forget `res.on('finish', …)`
    // invocation-logger. We don't invoke the callback (it dynamically imports a
    // DB-backed service); a no-op registrar is enough for the response assertions.
    on() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: unknown };
}

function makeReq(token: string): NextApiRequest {
  // No `origin` header → setBlockCors returns 'fallthrough' (it only "handles"
  // an OPTIONS preflight), so the GET request proceeds to the flag/JWT logic.
  // `id` matches ctx.modelId so the models:read:self context binding passes.
  return {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    query: { id: String(MODEL_ID) },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

beforeEach(() => {
  mockFlipt.runtime = false;
  mockFlipt.user = false;
  isFliptMock.mockClear();
});

describe('withBlockScope — Decision 4 runtime gate (real JWT round-trip)', () => {
  it('flag OFF (even with USER flag ON): falls through to the wrapped handler, never grants block scope', async () => {
    mockFlipt.runtime = false;
    mockFlipt.user = true; // user flag on must NOT enable runtime verification

    const token = await mintValidToken();
    const seen: { blockClaims?: unknown } = {};
    const wrapped = vi.fn(async (req: NextApiRequest, res: NextApiResponse) => {
      seen.blockClaims = (req as BlockScopedNextApiRequest).blockClaims;
      res.status(200).json({ via: 'legacy' });
    });

    const route = withBlockScope(wrapped as never, { endpoint: 'models', requiredScope: REQUIRED_SCOPE });
    const res = makeRes();
    await route(makeReq(token) as never, res as never);

    // Fell through to the wrapped (legacy-auth) handler…
    expect(wrapped).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ via: 'legacy' });
    // …WITHOUT ever granting block scope (the present valid JWT was treated as
    // absent — the exact dark behaviour). No 401 was emitted either.
    expect(seen.blockClaims).toBeUndefined();
    // It read the runtime key, NOT the user key.
    expect(isFliptMock).toHaveBeenCalledWith('app-blocks-runtime-enabled');
    expect(isFliptMock).not.toHaveBeenCalledWith('app-blocks-enabled');
  });

  it('flag ABSENT (isFlipt → false): same dark fall-through, no block scope', async () => {
    // mockFlipt.runtime defaults false == flag absent / Flipt down.
    const token = await mintValidToken();
    const seen: { blockClaims?: unknown } = {};
    const wrapped = vi.fn(async (req: NextApiRequest, res: NextApiResponse) => {
      seen.blockClaims = (req as BlockScopedNextApiRequest).blockClaims;
      res.status(200).json({ via: 'legacy' });
    });

    const route = withBlockScope(wrapped as never, { endpoint: 'models', requiredScope: REQUIRED_SCOPE });
    const res = makeRes();
    await route(makeReq(token) as never, res as never);

    expect(wrapped).toHaveBeenCalledTimes(1);
    expect(seen.blockClaims).toBeUndefined();
  });

  it('flag ON: VERIFIES the valid JWT and GRANTS the scoped context (req.blockClaims set)', async () => {
    mockFlipt.runtime = true;

    const token = await mintValidToken();
    const seen: { blockClaims?: BlockScopedNextApiRequest['blockClaims'] } = {};
    const wrapped = vi.fn(async (req: NextApiRequest, res: NextApiResponse) => {
      seen.blockClaims = (req as BlockScopedNextApiRequest).blockClaims;
      res.status(200).json({ via: 'block' });
    });

    const route = withBlockScope(wrapped as never, { endpoint: 'models', requiredScope: REQUIRED_SCOPE });
    const res = makeRes();
    await route(makeReq(token) as never, res as never);

    // The wrapped handler ran WITH the verified block scope.
    expect(wrapped).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ via: 'block' });
    // Non-vacuous: the verified claims were attached to the request, proving the
    // middleware actually validated the JWT (not just "didn't 503").
    expect(seen.blockClaims).toBeDefined();
    expect(seen.blockClaims?.blockInstanceId).toBe('bki_test');
    expect(seen.blockClaims?.appBlockId).toBe('apb_test');
    expect(seen.blockClaims?.scopes).toContain(REQUIRED_SCOPE);
    expect(seen.blockClaims?.ctx).toMatchObject({ modelId: MODEL_ID });
    // It read the runtime key, NOT the user key.
    expect(isFliptMock).toHaveBeenCalledWith('app-blocks-runtime-enabled');
    expect(isFliptMock).not.toHaveBeenCalledWith('app-blocks-enabled');
  });
});
