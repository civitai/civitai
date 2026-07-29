import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for POST /api/v1/blocks/shared-storage/increment. Authz
 * (scope/revoked/anon) is in collections-tip-authz.test.ts; the isolation +
 * min-trust gate live in apps-shared.counters.test.ts. This exercises the REST
 * wrapper: method/body guards, the bearer passthrough, and TRPCError→HTTP mapping
 * (sub-trust FORBIDDEN → 403, rate-limit → 429).
 */

function createMocks({
  method = 'POST',
  body = {},
  auth = 'Bearer tok',
}: { method?: string; body?: unknown; auth?: string } = {}) {
  const req = {
    method,
    body,
    query: {},
    headers: { authorization: auth },
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as Record<string, unknown>;
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader() {},
    end() {
      return res;
    },
    _status: () => statusCode,
    _json: () => payload,
  };
  return { req, res };
}

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
  // W13 audit-detail stash — the endpoint imports + calls this on the happy path.
  // Omitting it (as this mock originally did) is exactly what made the call site
  // `undefined(...)` → TypeError → 500 on a successful increment (#3161 regression);
  // exported here so the happy path exercises a real fn, and the regression test
  // below overrides it to throw to prove the enrichment can never 500.
  stashBlockActionDetail: (...args: unknown[]) => mockStash(...args),
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: any) => h }));

const { mockIncrement, mockStash } = vi.hoisted(() => ({
  mockIncrement: vi.fn(),
  mockStash: vi.fn(),
}));
vi.mock('~/server/routers/apps-shared.router', () => ({
  incrementSharedCounter: mockIncrement,
  // identity — the endpoint's zod schema already bounds the key
  assertValidCounterKey: (k: string) => k,
}));

import handler from '~/pages/api/v1/blocks/shared-storage/increment';

function fakeClaims(): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'j',
    blockId: 'b',
    appId: 'a',
    appBlockId: 'apb',
    blockInstanceId: 'bki',
    ctx: {},
    scopes: ['apps:storage:shared:write'],
  } as BlockTokenClaims;
}

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  mockIncrement.mockResolvedValue({ key: 'playcount:7', count: 4 });
});

describe('POST /api/v1/blocks/shared-storage/increment', () => {
  it('405 for a non-POST method', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    await handler(req as never, res as never);
    expect(res._status()).toBe(405);
  });

  it('401 when blockClaims is absent', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks({ body: { key: 'playcount:7' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(401);
  });

  it('400 for a missing/invalid key', async () => {
    const { req, res } = createMocks({ body: {} });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
    expect(mockIncrement).not.toHaveBeenCalled();
  });

  it('400 for an oversized key (>64)', async () => {
    const { req, res } = createMocks({ body: { key: 'x'.repeat(65) } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
  });

  it('200: increments and returns { key, count }, passing the bearer through', async () => {
    const { req, res } = createMocks({ body: { key: 'playcount:7' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ key: 'playcount:7', count: 4 });
    expect(mockIncrement).toHaveBeenCalledWith('tok', 'playcount:7');
  });

  it('REGRESSION: audit-detail enrichment that THROWS still returns the real 200 (never 500)', async () => {
    // #3161 added a best-effort audit-detail stash on the happy path, inside the
    // handler try/catch. ANY throw at the enrichment call site (missing stash
    // export → `undefined(...)`, non-writable `res`, …) surfaced as a 500 on an
    // increment that already succeeded. The endpoint now wraps the entire
    // enrichment in a swallow-everything guard.
    mockStash.mockImplementationOnce(() => {
      throw new Error('stash boom (non-writable res)');
    });
    const { req, res } = createMocks({ body: { key: 'playcount:7' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ key: 'playcount:7', count: 4 });
    expect(mockIncrement).toHaveBeenCalledWith('tok', 'playcount:7');
    expect(mockStash).toHaveBeenCalledTimes(1);
  });

  it('maps a sub-trust FORBIDDEN → 403 (min-trust gate; app treats increment as best-effort)', async () => {
    mockIncrement.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'account too new' })
    );
    const { req, res } = createMocks({ body: { key: 'playcount:7' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(403);
  });

  it('maps a rate-limit TOO_MANY_REQUESTS → 429', async () => {
    mockIncrement.mockRejectedValueOnce(
      new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'slow down' })
    );
    const { req, res } = createMocks({ body: { key: 'playcount:7' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(429);
  });
});
