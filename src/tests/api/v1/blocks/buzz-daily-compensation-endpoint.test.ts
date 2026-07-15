import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for GET /api/v1/blocks/buzz/daily-compensation
 * (per-modelVersion generation earnings). Authz is middleware territory;
 * CORS/scope wiring is in scoped-endpoints-cors-wiring.test.ts. This exercises
 * the inner handler: self-binding and query parsing.
 */

function createMocks({
  method = 'GET',
  query = {},
}: { method?: string; query?: Record<string, string> } = {}) {
  const req = {
    method,
    query,
    headers: {},
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as Record<string, unknown>;
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

const { mockGetDailyCompensation, mockHandleEndpointError, mockRate } = vi.hoisted(() => ({
  mockGetDailyCompensation: vi.fn(),
  mockHandleEndpointError: vi.fn(),
  mockRate: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({
  getDailyCompensationRewardByUser: mockGetDailyCompensation,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: mockHandleEndpointError,
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: mockRate,
}));

import handler from '~/pages/api/v1/blocks/buzz/daily-compensation';

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
    scopes: ['buzz:read:self'],
    ...over,
  } as BlockTokenClaims;
}

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  mockRate.mockResolvedValue({ allowed: true });
  mockGetDailyCompensation.mockResolvedValue({ resources: [], hasPublishedResources: false });
});

describe('GET /api/v1/blocks/buzz/daily-compensation', () => {
  it('405 for a non-GET method', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { date: '2026-07-01' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(405);
  });

  it('401 when blockClaims is absent', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks({ query: { date: '2026-07-01' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(401);
  });

  it('403 for an anonymous token (no "self" compensation)', async () => {
    claimsBox.claims = fakeClaims({ sub: 'anon' as never });
    const { req, res } = createMocks({ query: { date: '2026-07-01' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(403);
    expect(mockGetDailyCompensation).not.toHaveBeenCalled();
  });

  it('400 when date is missing or invalid', async () => {
    const badQueries: Record<string, string>[] = [
      {},
      { date: 'not-a-date' },
      { date: '2026-07-01', source: 'nope' },
    ];
    for (const query of badQueries) {
      const { req, res } = createMocks({ query });
      await handler(req as never, res as never);
      expect(res._status()).toBe(400);
    }
    expect(mockGetDailyCompensation).not.toHaveBeenCalled();
  });

  it('429 when the per-instance rate limit trips, before the ClickHouse-backed service is called', async () => {
    mockRate.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 7 });
    const { req, res } = createMocks({ query: { date: '2026-07-01' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(429);
    expect(res._headers()['Retry-After']).toBe('7');
    expect(mockGetDailyCompensation).not.toHaveBeenCalled();
  });

  it('checks the rate limit (keyed on blockInstanceId) before the service call', async () => {
    const order: string[] = [];
    mockRate.mockImplementationOnce(async () => {
      order.push('rate');
      return { allowed: true };
    });
    mockGetDailyCompensation.mockImplementationOnce(async () => {
      order.push('service');
      return { resources: [], hasPublishedResources: false };
    });
    const { req, res } = createMocks({ query: { date: '2026-07-01' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockRate).toHaveBeenCalledWith('bki');
    expect(order).toEqual(['rate', 'service']);
  });

  it('200: keyed on the verified subject, source defaults to compensation', async () => {
    const { req, res } = createMocks({ query: { date: '2026-07-01' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ resources: [], hasPublishedResources: false });
    expect(mockGetDailyCompensation).toHaveBeenCalledWith({
      userId: 42,
      date: new Date('2026-07-01'),
      source: 'compensation',
      accountType: undefined,
    });
  });

  it('200: passes source/accountType through', async () => {
    const { req, res } = createMocks({
      query: { date: '2026-06-15', source: 'licenseFee', accountType: 'green' },
    });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockGetDailyCompensation).toHaveBeenCalledWith({
      userId: 42,
      date: new Date('2026-06-15'),
      source: 'licenseFee',
      accountType: 'green',
    });
  });

  it('delegates service failures to handleEndpointError', async () => {
    mockGetDailyCompensation.mockRejectedValueOnce(new Error('clickhouse down'));
    const { req, res } = createMocks({ query: { date: '2026-07-01' } });
    await handler(req as never, res as never);
    expect(mockHandleEndpointError).toHaveBeenCalledWith(res, expect.any(Error));
  });
});
