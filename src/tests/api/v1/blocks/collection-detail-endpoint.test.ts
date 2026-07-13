import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for GET /api/v1/blocks/collections/[id] (detail). Authz
 * (scope/revoked/anon-token) is in collections-tip-authz.test.ts; this exercises
 * visibility (private→404), the maturity clamp threading, media mapping, and the
 * playable-only (image/video) filter.
 */

function createMocks({
  method = 'GET',
  query = {},
}: { method?: string; query?: Record<string, unknown> } = {}) {
  const req = { method, query, headers: {}, socket: { remoteAddress: '203.0.113.7' } } as unknown as Record<
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

const { mockPerms, mockGetById, mockItems, mockHydrate, mockFollowed, mockRate, mockMaturity } =
  vi.hoisted(() => ({
    mockPerms: vi.fn(),
    mockGetById: vi.fn(),
    mockItems: vi.fn(),
    mockHydrate: vi.fn(),
    mockFollowed: vi.fn(),
    mockRate: vi.fn(),
    mockMaturity: vi.fn(),
  }));

vi.mock('~/server/services/collection.service', () => ({
  getUserCollectionPermissionsById: mockPerms,
  getCollectionById: mockGetById,
  getCollectionItemsByCollectionId: mockItems,
}));
vi.mock('~/server/services/blocks/block-collections.service', () => ({
  hydrateBlockSubject: mockHydrate,
  getFollowedCollectionIds: mockFollowed,
  mapImageItemToMedia: (data: any) => ({
    mediaId: data.id,
    type: data.type === 'video' ? 'video' : 'image',
    url: `edge:${data.url}`,
    width: data.width ?? null,
    height: data.height ?? null,
    creator: data.user ? { userId: data.user.id, username: data.user.username } : null,
    nsfwLevel: data.nsfwLevel ?? 0,
  }),
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({ checkBlockCatalogRateLimit: mockRate }));
vi.mock('~/server/utils/block-catalog-maturity', () => ({ resolveCatalogBrowsingLevel: mockMaturity }));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => ({}),
  isRegionRestricted: () => false,
}));

import handler from '~/pages/api/v1/blocks/collections/[id]/index';

function fakeClaims(over: Partial<BlockTokenClaims> = {}): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'j',
    blockId: 'blk',
    appId: 'app',
    appBlockId: 'apb',
    blockInstanceId: 'bki',
    ctx: {},
    scopes: ['collections:read:self'],
    maxBrowsingLevel: 3,
    ...over,
  } as BlockTokenClaims;
}

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  mockRate.mockResolvedValue({ allowed: true });
  mockMaturity.mockReturnValue({ browsingLevel: 3, isSfwCeiling: true });
  mockHydrate.mockResolvedValue({ id: 42, username: 'mod', isModerator: false });
  mockPerms.mockResolvedValue({ read: true });
  mockFollowed.mockResolvedValue(new Set<number>([7]));
  mockGetById.mockResolvedValue({
    id: 7,
    name: 'Playlist',
    description: 'a mix',
    read: 'Public',
    userId: 100,
    user: { id: 100, username: 'alice' },
  });
});

describe('GET /api/v1/blocks/collections/[id]', () => {
  it('405 for a non-GET method', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { id: '7' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(405);
  });

  it('401 when blockClaims is absent', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks({ query: { id: '7' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(401);
  });

  it('403 for an anonymous token', async () => {
    claimsBox.claims = fakeClaims({ sub: 'anon' as never });
    const { req, res } = createMocks({ query: { id: '7' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(403);
  });

  it('400 for a non-numeric collection id', async () => {
    const { req, res } = createMocks({ query: { id: 'abc' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
  });

  it('404 (not 403) for a private collection the subject cannot read — no existence oracle', async () => {
    mockPerms.mockResolvedValueOnce({ read: false });
    const { req, res } = createMocks({ query: { id: '7' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(404);
    // getCollectionById is never reached (visibility gate fails first).
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it('404 when the collection row is gone (getCollectionById throws)', async () => {
    mockGetById.mockRejectedValueOnce(new Error('No collection'));
    const { req, res } = createMocks({ query: { id: '7' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(404);
  });

  it('200: threads the clamped browsingLevel, maps image/video, drops non-media, sets followed', async () => {
    mockItems.mockResolvedValueOnce({
      items: [
        { type: 'image', data: { id: 1, url: 'i1', type: 'image', width: 512, height: 512, nsfwLevel: 1, user: { id: 100, username: 'alice' } } },
        { type: 'image', data: { id: 2, url: 'v2', type: 'video', width: 1280, height: 720, nsfwLevel: 1, user: { id: 100, username: 'alice' } } },
        { type: 'model', data: { id: 999 } }, // dropped — not playable media
      ],
      nextCursor: '2',
    });
    const { req, res } = createMocks({ query: { id: '7', limit: '24' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    const body = res._json() as any;
    // The maturity clamp is the token ceiling threaded into the item service.
    expect(mockItems).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ collectionId: 7, browsingLevel: 3, statuses: ['ACCEPTED'] }),
        user: expect.objectContaining({ id: 42 }),
      })
    );
    expect(body.collection).toEqual({
      id: 7,
      name: 'Playlist',
      description: 'a mix',
      curator: { userId: 100, username: 'alice' },
      isPublic: true,
      followed: true,
    });
    // Only the 2 media items; the model item is dropped. Video type preserved.
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ mediaId: 1, type: 'image', url: 'edge:i1' });
    expect(body.items[1]).toMatchObject({ mediaId: 2, type: 'video', url: 'edge:v2' });
    expect(body.nextCursor).toBe('2');
  });
});
