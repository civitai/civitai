import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';
import { TransactionType } from '~/shared/constants/buzz.constants';

/**
 * Handler-level coverage for GET /api/v1/blocks/buzz/transactions (ledger
 * readout). Authz (missing-scope / revoked) is middleware territory; CORS/scope
 * wiring is in scoped-endpoints-cors-wiring.test.ts. This exercises the inner
 * handler: self-binding, query parsing, and the response projection.
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

const { mockGetTransactions, mockHandleEndpointError, mockRate } = vi.hoisted(() => ({
  mockGetTransactions: vi.fn(),
  mockHandleEndpointError: vi.fn(),
  mockRate: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzTransactions: mockGetTransactions,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: mockHandleEndpointError,
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: mockRate,
}));

import handler from '~/pages/api/v1/blocks/buzz/transactions';

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

const sampleRow = {
  date: new Date('2026-07-01T12:00:00Z'),
  type: TransactionType.Tip,
  fromAccountId: 7,
  toAccountId: 42,
  fromAccountType: 'yellow',
  toAccountType: 'yellow',
  amount: 100,
  description: 'Tip: nice model',
  details: { entityId: 5, entityType: 'Model' },
  externalTransactionId: 'ext-1',
  // Extra user fields prove the {id, username} projection strips them.
  fromUser: { id: 7, username: 'tipper', status: 'active' },
  toUser: { id: 42, username: 'me', status: 'active' },
};

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  mockRate.mockResolvedValue({ allowed: true });
  mockGetTransactions.mockResolvedValue({
    cursor: new Date('2026-06-30T00:00:00Z'),
    transactions: [sampleRow],
  });
});

describe('GET /api/v1/blocks/buzz/transactions', () => {
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

  it('403 for an anonymous token (no "self" ledger)', async () => {
    claimsBox.claims = fakeClaims({ sub: 'anon' as never });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(403);
    expect(mockGetTransactions).not.toHaveBeenCalled();
  });

  it('400 for an invalid query (unknown pool / out-of-range limit)', async () => {
    const badQueries: Record<string, string>[] = [
      { accountType: 'red' },
      { limit: '500' },
      { cursor: 'not-a-date' },
    ];
    for (const query of badQueries) {
      const { req, res } = createMocks({ query });
      await handler(req as never, res as never);
      expect(res._status()).toBe(400);
    }
    expect(mockGetTransactions).not.toHaveBeenCalled();
  });

  it('200: defaults to yellow/limit 50, keyed on the verified subject', async () => {
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockGetTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 42, accountType: 'yellow', limit: 50 })
    );
  });

  it('200: coerces query params and maps the type name to its enum value', async () => {
    const { req, res } = createMocks({
      query: {
        accountType: 'creatorProgramBank',
        type: 'Tip',
        cursor: '2026-06-01T00:00:00Z',
        start: '2026-05-01T00:00:00Z',
        end: '2026-07-01T00:00:00Z',
        limit: '200',
      },
    });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockGetTransactions).toHaveBeenCalledWith({
      accountId: 42,
      accountType: 'creatorProgramBank',
      type: TransactionType.Tip,
      cursor: new Date('2026-06-01T00:00:00Z'),
      start: new Date('2026-05-01T00:00:00Z'),
      end: new Date('2026-07-01T00:00:00Z'),
      limit: 200,
    });
  });

  it('429 when the per-instance rate limit trips, before the service is called', async () => {
    mockRate.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 7 });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(429);
    expect(res._headers()['Retry-After']).toBe('7');
    expect(mockGetTransactions).not.toHaveBeenCalled();
  });

  it('checks the rate limit (keyed on blockInstanceId) before the service call', async () => {
    const order: string[] = [];
    mockRate.mockImplementationOnce(async () => {
      order.push('rate');
      return { allowed: true };
    });
    mockGetTransactions.mockImplementationOnce(async () => {
      order.push('service');
      return { cursor: null, transactions: [] };
    });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockRate).toHaveBeenCalledWith('bki');
    expect(order).toEqual(['rate', 'service']);
  });

  it('F1: allowlists details — DROPS stripePaymentIntentId, keeps attribution fields', async () => {
    // A Purchase row: buzz.service stores the Stripe payment-intent ref inside
    // details.passthrough(). It must never reach the block iframe.
    mockGetTransactions.mockResolvedValueOnce({
      cursor: null,
      transactions: [
        {
          ...sampleRow,
          details: {
            user: 'buyer',
            entityId: 5,
            entityType: 'Model',
            url: '/models/5',
            toAccountType: 'yellow',
            stripePaymentIntentId: 'pi_secret_123',
            someOtherPassthrough: 'leak',
          },
          externalTransactionId: 'pi_secret_123',
        },
      ],
    });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    const body = res._json() as { transactions: Record<string, unknown>[] };
    const details = body.transactions[0].details as Record<string, unknown>;
    expect(details).not.toHaveProperty('stripePaymentIntentId');
    expect(details).not.toHaveProperty('someOtherPassthrough');
    // Attribution fields the dashboard renders are preserved.
    expect(details).toMatchObject({
      user: 'buyer',
      entityId: 5,
      entityType: 'Model',
      url: '/models/5',
      toAccountType: 'yellow',
    });
  });

  it('200: passes attribution fields through and projects counterparties to {id, username}', async () => {
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    const body = res._json() as { cursor: Date; transactions: Record<string, unknown>[] };
    expect(body.cursor).toEqual(new Date('2026-06-30T00:00:00Z'));
    expect(body.transactions).toHaveLength(1);
    const row = body.transactions[0];
    expect(row.type).toBe('Tip');
    expect(row.description).toBe('Tip: nice model');
    expect(row.details).toEqual({ entityId: 5, entityType: 'Model' });
    expect(row.externalTransactionId).toBe('ext-1');
    expect(row.fromUser).toEqual({ id: 7, username: 'tipper' });
    expect(row.toUser).toEqual({ id: 42, username: 'me' });
  });

  it('delegates service failures to handleEndpointError', async () => {
    mockGetTransactions.mockRejectedValueOnce(new Error('buzz down'));
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(mockHandleEndpointError).toHaveBeenCalledWith(res, expect.any(Error));
  });
});
