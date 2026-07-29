import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for GET /api/v1/blocks/shared-storage/top. Authz is in
 * collections-tip-authz.test.ts; ordering/prefix/isolation live in
 * apps-shared.counters.test.ts. This exercises the REST wrapper: method guard,
 * the query bounds (limit), the bearer passthrough, and the response shape.
 */

function createMocks({
  method = 'GET',
  query = {},
}: { method?: string; query?: Record<string, unknown> } = {}) {
  const req = {
    method,
    query,
    headers: { authorization: 'Bearer tok' },
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
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: any) => h }));

const { mockTop } = vi.hoisted(() => ({ mockTop: vi.fn() }));
vi.mock('~/server/routers/apps-shared.router', () => ({ getTopSharedCounters: mockTop }));

import handler from '~/pages/api/v1/blocks/shared-storage/top';

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
    scopes: ['apps:storage:shared:read'],
  } as BlockTokenClaims;
}

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  mockTop.mockResolvedValue([
    { key: 'playcount:9', count: 42 },
    { key: 'playcount:3', count: 7 },
  ]);
});

describe('GET /api/v1/blocks/shared-storage/top', () => {
  it('405 for a non-GET method', async () => {
    const { req, res } = createMocks({ method: 'POST' });
    await handler(req as never, res as never);
    expect(res._status()).toBe(405);
  });

  it('401 when blockClaims is absent', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(401);
  });

  it('200: returns the top list, passing prefix + limit through', async () => {
    const { req, res } = createMocks({ query: { prefix: 'playcount:', limit: '10' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual([
      { key: 'playcount:9', count: 42 },
      { key: 'playcount:3', count: 7 },
    ]);
    expect(mockTop).toHaveBeenCalledWith('tok', 'playcount:', 10);
  });

  it('defaults prefix="" and limit=20 when omitted', async () => {
    const { req, res } = createMocks({ query: {} });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockTop).toHaveBeenCalledWith('tok', '', 20);
  });

  it('400 for an over-max limit (>100) — bounded', async () => {
    const { req, res } = createMocks({ query: { limit: '1000' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
    expect(mockTop).not.toHaveBeenCalled();
  });
});
