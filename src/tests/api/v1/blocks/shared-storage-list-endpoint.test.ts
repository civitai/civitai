import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for GET /api/v1/blocks/shared-storage/list.
 *
 * The AUTHORIZATION ladder this route rides — anon-may-read, the read-scope
 * assertion, the approved-block + revocation checks, the fail-closed kill switch,
 * per-app schema isolation — lives in `resolveSharedContext` and is pinned in
 * `src/server/routers/__tests__/apps-shared.router.test.ts`. It is NOT re-tested
 * here: this route reaches it through the very same `listSharedRows` the tRPC
 * procedure calls, which is the point of the extraction, and a second copy of
 * those assertions over a mocked resolver would assert nothing about the ladder.
 *
 * What IS this file's business is the REST wrapper: the method guard, the query
 * bounds, that the BEARER TOKEN is what gets handed down (not a claim off the
 * request), the pagination envelope, and that a failure goes to the shared error
 * chokepoint rather than being serialized here.
 *
 * Fixtures are deliberately pairwise distinct and non-zero (limit 3, counts 5/2,
 * author ids 31/19) so a transposition — limit read as a count, one author id for
 * another — cannot survive by landing on an equal value.
 */

function createMocks({
  method = 'GET',
  query = {},
  authorization = 'Bearer tok_list',
}: { method?: string; query?: Record<string, unknown>; authorization?: string } = {}) {
  const req = {
    method,
    query,
    url: '/api/v1/blocks/shared-storage/list',
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

const { mockList, mockHandleEndpointError } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockHandleEndpointError: vi.fn(),
}));
vi.mock('~/server/routers/apps-shared.router', () => ({
  listSharedRows: mockList,
  SHARED_PREFIX_MAX: 64,
  SHARED_CURSOR_MAX: 200,
  SHARED_LIST_LIMIT_MAX: 100,
  SHARED_LIST_LIMIT_DEFAULT: 50,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: mockHandleEndpointError,
}));

import handler from '~/pages/api/v1/blocks/shared-storage/list';

const ROWS = [
  {
    key: 'k7',
    authorUserId: 31,
    value: { title: 'alpha' },
    count: 5,
    createdAt: new Date('2026-03-04T05:06:07.000Z'),
    updatedAt: new Date('2026-03-05T06:07:08.000Z'),
    viewerVoted: true,
  },
  {
    key: 'k3',
    authorUserId: 19,
    value: { title: 'beta' },
    count: 2,
    createdAt: new Date('2026-02-01T01:02:03.000Z'),
    updatedAt: new Date('2026-02-02T02:03:04.000Z'),
    viewerVoted: false,
  },
];

function fakeClaims(over: Partial<BlockTokenClaims> = {}): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:31',
    iat: 0,
    exp: 0,
    jti: 'j',
    blockId: 'b',
    appId: 'a',
    appBlockId: 'apb',
    blockInstanceId: 'bki',
    ctx: {},
    scopes: ['apps:storage:shared:read'],
    ...over,
  } as BlockTokenClaims;
}

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  mockList.mockResolvedValue({ items: ROWS, nextCursor: 'azM=' });
});

describe('GET /api/v1/blocks/shared-storage/list', () => {
  it('405 for a non-GET method', async () => {
    const { req, res } = createMocks({ method: 'POST' });
    await handler(req as never, res as never);
    expect(res._status()).toBe(405);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('401 when blockClaims is absent', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('200: hands the BEARER token + prefix/limit/cursor down and returns the items', async () => {
    const { req, res } = createMocks({
      query: { prefix: 'req:', limit: '3', cursor: 'azc=' },
    });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    // The token comes off the Authorization header, NOT off req.blockClaims — the
    // downstream resolver re-verifies it, so handing it anything else would move
    // the authorization decision onto data this handler chose.
    expect(mockList).toHaveBeenCalledWith('tok_list', {
      prefix: 'req:',
      limit: 3,
      cursor: 'azc=',
    });
    expect((res._json() as { items: unknown[] }).items).toEqual(ROWS);
  });

  it('200: the house pagination envelope — metadata.nextCursor + a nextPage carrying it', async () => {
    const { req, res } = createMocks({ query: { limit: '3' } });
    await handler(req as never, res as never);
    const body = res._json() as { metadata: { nextCursor?: string; nextPage?: string } };
    expect(body.metadata.nextCursor).toBe('azM=');
    // nextPage is a real follow-on URL carrying the cursor, not an echo of the
    // request: assert the cursor is IN it, so a handler that forgot to thread
    // nextCursor into getNextPage fails here.
    expect(body.metadata.nextPage).toContain('/api/v1/blocks/shared-storage/list');
    expect(decodeURIComponent(body.metadata.nextPage ?? '')).toContain('cursor=azM=');
  });

  it('200: no nextCursor → nextPage is undefined (last page)', async () => {
    mockList.mockResolvedValueOnce({ items: [ROWS[0]], nextCursor: undefined });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    const body = res._json() as { metadata: { nextCursor?: string; nextPage?: string } };
    expect(body.metadata.nextCursor).toBeUndefined();
    expect(body.metadata.nextPage).toBeUndefined();
  });

  it('defaults limit=50 with no prefix/cursor when omitted', async () => {
    const { req, res } = createMocks({ query: {} });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockList).toHaveBeenCalledWith('tok_list', {
      prefix: undefined,
      limit: 50,
      cursor: undefined,
    });
  });

  it('400 for an over-max limit (>100) — bounded, and nothing is read', async () => {
    const { req, res } = createMocks({ query: { limit: '101' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('400 for limit=0 and for a non-numeric limit', async () => {
    for (const limit of ['0', 'lots']) {
      const { req, res } = createMocks({ query: { limit } });
      await handler(req as never, res as never);
      expect(res._status(), `limit=${limit}`).toBe(400);
    }
    expect(mockList).not.toHaveBeenCalled();
  });

  it('400 for an over-long prefix (>64)', async () => {
    const { req, res } = createMocks({ query: { prefix: 'p'.repeat(65) } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('a read failure goes to the shared error chokepoint, not a body built here', async () => {
    // 🔴 The behaviour under test is that the route does NOT serialize the error
    // itself: a raw `pg` failure out of the pool carries this app's schema name and
    // possibly the offending row value in `.message`, and the two older
    // shared-storage routes forward exactly that. Assert the error object reaches
    // `handleEndpointError` UNTOUCHED and that no response body was written here.
    const boom = new Error('relation "app_voting.shared_kv" does not exist');
    mockList.mockRejectedValueOnce(boom);
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(mockHandleEndpointError).toHaveBeenCalledWith(res, boom);
    expect(res._json()).toBeUndefined();
  });
});
