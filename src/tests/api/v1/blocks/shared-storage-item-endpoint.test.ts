import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for GET /api/v1/blocks/shared-storage/item.
 *
 * As with the list route, the authorization ladder lives in
 * `resolveSharedContext` and is pinned in `apps-shared.router.test.ts`; this file
 * covers the REST wrapper — method guard, key bounds, bearer passthrough, the
 * miss-is-a-200 contract, and delegation of failures to the shared chokepoint.
 */

function createMocks({
  method = 'GET',
  query = {},
  authorization = 'Bearer tok_item',
}: { method?: string; query?: Record<string, unknown>; authorization?: string } = {}) {
  const req = {
    method,
    query,
    url: '/api/v1/blocks/shared-storage/item',
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

const { mockGetRow, mockHandleEndpointError } = vi.hoisted(() => ({
  mockGetRow: vi.fn(),
  mockHandleEndpointError: vi.fn(),
}));
vi.mock('~/server/routers/apps-shared.router', () => ({
  getSharedRow: mockGetRow,
  SHARED_KEY_MAX: 64,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: mockHandleEndpointError,
}));

import handler from '~/pages/api/v1/blocks/shared-storage/item';

const ITEM = {
  key: 'k11',
  authorUserId: 23,
  value: { title: 'gamma' },
  count: 7,
  createdAt: new Date('2026-04-05T06:07:08.000Z'),
  updatedAt: new Date('2026-04-06T07:08:09.000Z'),
  viewerVoted: true,
};

function fakeClaims(): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:23',
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
  mockGetRow.mockResolvedValue({ item: ITEM });
});

describe('GET /api/v1/blocks/shared-storage/item', () => {
  it('405 for a non-GET method', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { key: 'k11' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(405);
    expect(mockGetRow).not.toHaveBeenCalled();
  });

  it('401 when blockClaims is absent', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks({ query: { key: 'k11' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(401);
    expect(mockGetRow).not.toHaveBeenCalled();
  });

  it('200: hands the BEARER token + the key down and returns { item }', async () => {
    const { req, res } = createMocks({ query: { key: 'k11' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockGetRow).toHaveBeenCalledWith('tok_item', 'k11');
    expect(res._json()).toEqual({ item: ITEM });
  });

  it('200 with item:null for a missing OR hidden key — NOT a 404', async () => {
    // 🔴 The status is the contract. A hidden (withdrawn / moderator-purged) row
    // and a key that never existed must be INDISTINGUISHABLE to the caller; a 404
    // for one and a 200 for the other would turn this route into an oracle for
    // "does a hidden row with this key exist".
    mockGetRow.mockResolvedValueOnce({ item: null });
    const { req, res } = createMocks({ query: { key: 'k-hidden' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(res._json()).toEqual({ item: null });
  });

  it('400 when key is missing', async () => {
    const { req, res } = createMocks({ query: {} });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
    expect(mockGetRow).not.toHaveBeenCalled();
  });

  it('400 for an empty key and for an over-long key (>64) — the bound bites at 65, not 64', async () => {
    // Both sides of the boundary, so a `<` / `<=` slip is visible.
    const ok = 'k'.repeat(64);
    const tooLong = 'k'.repeat(65);

    const a = createMocks({ query: { key: '' } });
    await handler(a.req as never, a.res as never);
    expect(a.res._status()).toBe(400);

    const b = createMocks({ query: { key: tooLong } });
    await handler(b.req as never, b.res as never);
    expect(b.res._status()).toBe(400);

    expect(mockGetRow).not.toHaveBeenCalled();

    const c = createMocks({ query: { key: ok } });
    await handler(c.req as never, c.res as never);
    expect(c.res._status()).toBe(200);
    expect(mockGetRow).toHaveBeenCalledWith('tok_item', ok);
  });

  it('a read failure goes to the shared error chokepoint, not a body built here', async () => {
    const boom = new Error('relation "app_voting.shared_kv" does not exist');
    mockGetRow.mockRejectedValueOnce(boom);
    const { req, res } = createMocks({ query: { key: 'k11' } });
    await handler(req as never, res as never);
    expect(mockHandleEndpointError).toHaveBeenCalledWith(res, boom);
    expect(res._json()).toBeUndefined();
  });
});
