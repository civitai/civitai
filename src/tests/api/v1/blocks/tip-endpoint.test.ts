import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for POST /api/v1/blocks/tip. Authz is in
 * collections-tip-authz.test.ts; this exercises the input guards (self-tip,
 * amount bounds, entity pairing), the per-instance rate limit, banned/muted
 * gates, the reuse of the REAL money flow (createBuzzTipTransactionHandler,
 * self-bound sender), and TRPCError→HTTP mapping (insufficient funds → 400).
 */

function createMocks({
  method = 'POST',
  body = {},
}: { method?: string; body?: unknown } = {}) {
  const req = { method, body, query: {}, headers: {}, socket: { remoteAddress: '203.0.113.7' } } as unknown as Record<
    string,
    unknown
  >;
  let statusCode = 200;
  let payload: unknown;
  const headers: Record<string, string> = {};
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    end() {
      return res;
    },
    _status: () => statusCode,
    _json: () => payload,
    _headers: () => headers,
  };
  return { req, res };
}

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };
class ForbiddenError extends Error {
  readonly status = 403 as const;
}

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
  parseSubjectUserId: (sub: string): number | null => {
    if (sub === 'anon') return null;
    if (!/^user:\d+$/.test(sub)) throw new ForbiddenError('bad');
    return Number.parseInt(sub.slice('user:'.length), 10);
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: any) => h }));

const { mockTip, mockHydrate, mockRate } = vi.hoisted(() => ({
  mockTip: vi.fn(),
  mockHydrate: vi.fn(),
  mockRate: vi.fn(),
}));

vi.mock('~/server/controllers/buzz.controller', () => ({
  createBuzzTipTransactionHandler: mockTip,
}));
// Tracker is instantiated for the fabricated ctx — a no-op class is enough.
vi.mock('~/server/clickhouse/client', () => ({ Tracker: class {} }));
vi.mock('~/server/services/blocks/block-collections.service', () => ({
  hydrateBlockSubject: mockHydrate,
}));
vi.mock('~/server/utils/block-tip-rate-limit', () => ({ checkBlockTipRateLimit: mockRate }));

import handler from '~/pages/api/v1/blocks/tip';

function fakeClaims(over: Partial<BlockTokenClaims> = {}): BlockTokenClaims {
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
    scopes: ['social:tip:self'],
    ...over,
  } as BlockTokenClaims;
}

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  mockRate.mockResolvedValue({ allowed: true });
  mockHydrate.mockResolvedValue({ id: 42, username: 'mod', bannedAt: null, muted: false });
  mockTip.mockResolvedValue([{ transactionId: 't1' }]);
});

describe('POST /api/v1/blocks/tip', () => {
  it('405 for a non-POST method', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    await handler(req as never, res as never);
    expect(res._status()).toBe(405);
  });

  it('401 when blockClaims is absent', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks({ body: { toUserId: 5, amount: 10 } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(401);
  });

  it('403 for an anonymous token', async () => {
    claimsBox.claims = fakeClaims({ sub: 'anon' as never });
    const { req, res } = createMocks({ body: { toUserId: 5, amount: 10 } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(403);
  });

  it('400 for a missing/invalid body', async () => {
    const { req, res } = createMocks({ body: { toUserId: 5 } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
  });

  it('400 for a non-positive / over-max amount', async () => {
    const { req, res } = createMocks({ body: { toUserId: 5, amount: 0 } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
    const over = createMocks({ body: { toUserId: 5, amount: 1_000_000 } });
    await handler(over.req as never, over.res as never);
    expect(over.res._status()).toBe(400);
  });

  it('400 when entityType is supplied without entityId', async () => {
    const { req, res } = createMocks({ body: { toUserId: 5, amount: 10, entityType: 'Image' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
    expect(mockTip).not.toHaveBeenCalled();
  });

  it('400 for a self-tip (toUserId === subject)', async () => {
    const { req, res } = createMocks({ body: { toUserId: 42, amount: 10 } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
    expect(mockTip).not.toHaveBeenCalled();
  });

  it('429 when the per-instance tip rate limit trips', async () => {
    mockRate.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 });
    const { req, res } = createMocks({ body: { toUserId: 5, amount: 10 } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(429);
    expect(res._headers()['Retry-After']).toBe('30');
    expect(mockTip).not.toHaveBeenCalled();
  });

  it('403 when the subject is banned', async () => {
    mockHydrate.mockResolvedValueOnce({ id: 42, bannedAt: new Date(), muted: false });
    const { req, res } = createMocks({ body: { toUserId: 5, amount: 10 } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(403);
    expect(mockTip).not.toHaveBeenCalled();
  });

  it('200: reuses createBuzzTipTransactionHandler with a self-bound sender', async () => {
    const { req, res } = createMocks({
      body: { toUserId: 5, amount: 25, entityType: 'Image', entityId: 99 },
    });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({
      ok: true,
      tip: { toUserId: 5, amount: 25, entityType: 'Image', entityId: 99 },
    });
    expect(mockTip).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          toAccountId: 5,
          amount: 25,
          fromAccountType: 'yellow',
          toAccountType: 'yellow',
          entityType: 'Image',
          entityId: 99,
        },
        ctx: expect.objectContaining({ user: expect.objectContaining({ id: 42 }) }),
      })
    );
  });

  it('surfaces insufficient balance as a clean 400 (not a 500)', async () => {
    mockTip.mockRejectedValueOnce(
      new TRPCError({ code: 'BAD_REQUEST', message: "you don't have enough funds" })
    );
    const { req, res } = createMocks({ body: { toUserId: 5, amount: 999 } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
    expect((res._json() as any).ok).toBe(false);
    expect((res._json() as any).error).toMatch(/funds/);
  });

  it('maps an unexpected non-TRPC error → 500', async () => {
    mockTip.mockRejectedValueOnce(new Error('boom'));
    const { req, res } = createMocks({ body: { toUserId: 5, amount: 10 } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(500);
  });
});
