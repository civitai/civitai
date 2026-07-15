import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for GET /api/v1/blocks/buzz/accounts (all-pool balance
 * readout). Authz is middleware territory; CORS/scope wiring is in
 * scoped-endpoints-cors-wiring.test.ts. This exercises the inner handler's
 * self-bound multi-pool read and response projection.
 */

function createMocks({ method = 'GET' }: { method?: string } = {}) {
  const req = {
    method,
    query: {},
    headers: {},
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

const { mockAccount } = vi.hoisted(() => ({ mockAccount: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({ getUserBuzzAccount: mockAccount }));

import handler from '~/pages/api/v1/blocks/buzz/accounts';
import { blockBuzzAccountTypes } from '~/server/schema/buzz.schema';

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
  mockAccount.mockResolvedValue(
    blockBuzzAccountTypes.map((accountType, i) => ({
      id: 42,
      balance: (i + 1) * 100,
      lifetimeBalance: null,
      accountType,
    }))
  );
});

describe('GET /api/v1/blocks/buzz/accounts', () => {
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

  it('403 for an anonymous token (no "self" balances)', async () => {
    claimsBox.claims = fakeClaims({ sub: 'anon' as never });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(403);
    expect(mockAccount).not.toHaveBeenCalled();
  });

  it('200: reads every exposed pool for the verified subject, projecting {accountType, balance}', async () => {
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    // Keyed on the verified subject (42), never client input.
    expect(mockAccount).toHaveBeenCalledWith({
      accountId: 42,
      accountTypes: [...blockBuzzAccountTypes],
    });
    expect(res._json()).toEqual({
      accounts: blockBuzzAccountTypes.map((accountType, i) => ({
        accountType,
        balance: (i + 1) * 100,
      })),
    });
  });

  it('502 when the balance service throws', async () => {
    mockAccount.mockRejectedValueOnce(new Error('buzz down'));
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(502);
  });
});
