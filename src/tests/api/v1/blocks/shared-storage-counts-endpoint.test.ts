import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for GET /api/v1/blocks/shared-storage/counts.
 *
 * As with the sibling read routes, the authorization ladder lives in
 * `resolveSharedContext` and is pinned in `apps-shared.router.test.ts`. This file
 * covers the REST wrapper, and in particular the two query-shape decisions that
 * are easy to get quietly wrong: `?keys=a` (a bare string from Next) must be
 * treated as a one-element list, and a key containing a comma must NOT be split.
 */

function createMocks({
  method = 'GET',
  query = {},
  authorization = 'Bearer tok_counts',
}: { method?: string; query?: Record<string, unknown>; authorization?: string } = {}) {
  const req = {
    method,
    query,
    url: '/api/v1/blocks/shared-storage/counts',
    headers: { authorization, host: 'civitai.test' },
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
    setHeader() {
      return res;
    },
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

const { mockGetCounts, mockHandleEndpointError } = vi.hoisted(() => ({
  mockGetCounts: vi.fn(),
  mockHandleEndpointError: vi.fn(),
}));
vi.mock('~/server/routers/apps-shared.router', () => ({
  getSharedCounts: mockGetCounts,
  SHARED_KEY_MAX: 64,
  SHARED_COUNTS_KEYS_MAX: 100,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: mockHandleEndpointError,
}));

import handler from '~/pages/api/v1/blocks/shared-storage/counts';

function fakeClaims(): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:29',
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
  // Pairwise-distinct, non-zero tallies so a transposed key→count mapping cannot
  // pass by landing on an equal value.
  mockGetCounts.mockResolvedValue({ counts: { ka: 13, kb: 6 } });
});

describe('GET /api/v1/blocks/shared-storage/counts', () => {
  it('405 for a non-GET method', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { keys: 'ka' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(405);
    expect(mockGetCounts).not.toHaveBeenCalled();
  });

  it('401 when blockClaims is absent', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks({ query: { keys: 'ka' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(401);
    expect(mockGetCounts).not.toHaveBeenCalled();
  });

  it('200: a repeated ?keys= param arrives as the list, verbatim and in order', async () => {
    const { req, res } = createMocks({ query: { keys: ['ka', 'kb'] } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockGetCounts).toHaveBeenCalledWith('tok_counts', ['ka', 'kb']);
    expect(res._json()).toEqual({ counts: { ka: 13, kb: 6 } });
  });

  it('200: a SINGLE ?keys= param (a bare string from Next) becomes a one-element list', async () => {
    mockGetCounts.mockResolvedValueOnce({ counts: { ka: 13 } });
    const { req, res } = createMocks({ query: { keys: 'ka' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockGetCounts).toHaveBeenCalledWith('tok_counts', ['ka']);
  });

  it('does NOT comma-split a key — an app may legally choose one containing a comma', async () => {
    // 🔴 The failure this pins is silent: splitting `a,b` into two lookups that both
    // miss returns `{ counts: {} }` with a 200 and no error anywhere. Assert the key
    // reaches the reader WHOLE.
    mockGetCounts.mockResolvedValueOnce({ counts: { 'pair:a,b': 4 } });
    const { req, res } = createMocks({ query: { keys: 'pair:a,b' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockGetCounts).toHaveBeenCalledWith('tok_counts', ['pair:a,b']);
  });

  it('400 when keys is absent or empty', async () => {
    for (const query of [{}, { keys: [] }]) {
      const { req, res } = createMocks({ query });
      await handler(req as never, res as never);
      expect(res._status(), JSON.stringify(query)).toBe(400);
    }
    expect(mockGetCounts).not.toHaveBeenCalled();
  });

  it('400 above 100 keys — bounded at the boundary, 100 is accepted and 101 is not', async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => `k${i}`);
    const a = createMocks({ query: { keys: hundred } });
    await handler(a.req as never, a.res as never);
    expect(a.res._status()).toBe(200);
    expect(mockGetCounts).toHaveBeenCalledWith('tok_counts', hundred);

    mockGetCounts.mockClear();
    const b = createMocks({ query: { keys: [...hundred, 'k100'] } });
    await handler(b.req as never, b.res as never);
    expect(b.res._status()).toBe(400);
    expect(mockGetCounts).not.toHaveBeenCalled();
  });

  it('400 when any single key is over-long (>64) — the whole batch is rejected', async () => {
    const { req, res } = createMocks({ query: { keys: ['ka', 'k'.repeat(65)] } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
    expect(mockGetCounts).not.toHaveBeenCalled();
  });

  it('a read failure goes to the shared error chokepoint, not a body built here', async () => {
    const boom = new Error('relation "app_voting.counters" does not exist');
    mockGetCounts.mockRejectedValueOnce(boom);
    const { req, res } = createMocks({ query: { keys: 'ka' } });
    await handler(req as never, res as never);
    expect(mockHandleEndpointError).toHaveBeenCalledWith(res, boom);
    expect(res._json()).toBeUndefined();
  });
});
