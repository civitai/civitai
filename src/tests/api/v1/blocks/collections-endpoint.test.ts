import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for GET /api/v1/blocks/collections (discovery). The
 * shared authz layer (missing scope / revoked / anon-token via a real minted
 * token) is covered in collections-tip-authz.test.ts; withBlockScope is mocked
 * here as a passthrough that stamps req.blockClaims so we exercise the inner
 * handler's discovery + mapping + maturity + subject-binding logic.
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
    if (!/^user:\d+$/.test(sub)) throw new ForbiddenError('malformed sub claim');
    return Number.parseInt(sub.slice('user:'.length), 10);
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: any) => h }));

const {
  mockGetAll,
  mockItemCount,
  mockUserCollections,
  mockHydrate,
  mockFollowed,
  mockRate,
  mockMaturity,
  mockFallbackCovers,
} = vi.hoisted(() => ({
  mockGetAll: vi.fn(),
  mockItemCount: vi.fn(),
  mockUserCollections: vi.fn(),
  mockHydrate: vi.fn(),
  mockFollowed: vi.fn(),
  mockRate: vi.fn(),
  mockMaturity: vi.fn(),
  mockFallbackCovers: vi.fn(),
}));

vi.mock('~/server/services/collection.service', () => ({
  getAllCollections: mockGetAll,
  getCollectionItemCount: mockItemCount,
  getUserCollectionsWithPermissions: mockUserCollections,
}));
vi.mock('~/server/services/blocks/block-collections.service', () => ({
  hydrateBlockSubject: mockHydrate,
  getFollowedCollectionIds: mockFollowed,
  getFallbackCoverImages: mockFallbackCovers,
  // Cover url helper: a video cover yields a poster (`poster:` prefix), a still
  // image yields `edge:`; null when there is no url — mirrors toCoverImageUrl.
  toCoverImageUrl: (img: any) =>
    img?.url ? `${img.type === 'video' ? 'poster' : 'edge'}:${img.url}` : null,
  // Drop a collection whose nsfwLevel exceeds the (test) ceiling of 3.
  collectionWithinCeiling: (nsfwLevel: number, level: number) => nsfwLevel <= level,
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({ checkBlockCatalogRateLimit: mockRate }));
vi.mock('~/server/utils/block-catalog-maturity', () => ({
  resolveCatalogBrowsingLevel: mockMaturity,
}));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => ({}),
  isRegionRestricted: () => false,
}));

import handler from '~/pages/api/v1/blocks/collections/index';

function fakeClaims(over: Partial<BlockTokenClaims> = {}): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'jti',
    blockId: 'blk',
    appId: 'app',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_test',
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
  mockHydrate.mockResolvedValue({ id: 42, username: 'mod', isModerator: true });
  mockFollowed.mockResolvedValue(new Set<number>([10]));
  mockFallbackCovers.mockResolvedValue(new Map());
  mockItemCount.mockResolvedValue([
    { id: 10, count: 5 },
    { id: 11, count: 2 },
  ]);
});

describe('GET /api/v1/blocks/collections', () => {
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

  it('403 for an anonymous token (sub=anon)', async () => {
    claimsBox.claims = fakeClaims({ sub: 'anon' as never });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(403);
  });

  it('403 for a malformed subject claim', async () => {
    claimsBox.claims = fakeClaims({ sub: 'garbage' as never });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(403);
  });

  it('429 when the per-instance rate limit trips', async () => {
    mockRate.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 7 });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(429);
    expect(res._headers()['Retry-After']).toBe('7');
  });

  it('mode=public: maps collections, applies itemCount + followed + maturity drop', async () => {
    // id 10 (nsfw 1, followed) kept, id 11 (nsfw 1) kept, id 12 (nsfw 8 > ceiling 3) dropped.
    mockGetAll.mockResolvedValueOnce([
      {
        id: 10,
        name: 'A',
        description: 'desc A',
        read: 'Public',
        nsfwLevel: 1,
        userId: 100,
        user: { id: 100, username: 'alice' },
        image: { url: 'img10', type: 'image' },
      },
      {
        id: 11,
        name: 'B',
        description: null,
        read: 'Private',
        nsfwLevel: 1,
        userId: 101,
        user: { id: 101, username: 'bob' },
        image: null,
      },
      {
        id: 12,
        name: 'Mature',
        description: null,
        read: 'Public',
        nsfwLevel: 8,
        userId: 102,
        user: { id: 102, username: 'carol' },
        image: { url: 'img12', type: 'image' },
      },
    ]);
    const { req, res } = createMocks({ query: { mode: 'public', limit: '24' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    const body = res._json() as any;
    // The mature (nsfw 8) collection is dropped by the ceiling filter.
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toEqual({
      id: 10,
      name: 'A',
      description: 'desc A',
      coverImageUrl: 'edge:img10',
      itemCount: 5,
      curator: { userId: 100, username: 'alice' },
      isPublic: true,
      followed: true,
    });
    expect(body.items[1]).toMatchObject({
      id: 11,
      coverImageUrl: null,
      isPublic: false,
      followed: false,
      itemCount: 2,
    });
    // Public discovery pins privacy to Public.
    expect(mockGetAll).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ privacy: ['Public'] }),
        user: expect.objectContaining({ id: 42 }),
      })
    );
  });

  it('mode=public: nextCursor is the first UNCONSUMED row (clean inclusive resume, no dup)', async () => {
    mockGetAll.mockResolvedValueOnce([
      { id: 10, name: 'A', description: null, read: 'Public', nsfwLevel: 0, userId: 1, user: { id: 1, username: 'a' }, image: null },
      { id: 9, name: 'B', description: null, read: 'Public', nsfwLevel: 0, userId: 1, user: { id: 1, username: 'a' }, image: null },
    ]);
    const { req, res } = createMocks({ query: { mode: 'public', limit: '1' } });
    await handler(req as never, res as never);
    const body = res._json() as any;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(10);
    // Page shows [10]; the next page resumes INCLUSIVELY at the first unconsumed
    // row (9), never re-showing 10. Over-fetches (limit*4+1) in one query.
    expect(body.nextCursor).toBe(9);
    expect(mockGetAll).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ limit: 1 * 4 + 1 }) })
    );
  });

  it('mode=public: a maturity-clamped page STILL FILLS to `limit` and advances the cursor (no early termination)', async () => {
    // r9 (nsfw 8) is over the ceiling (3) → dropped by the clamp. The page must
    // still fill 2 VISIBLE items and set nextCursor past the last consumed row, so
    // later collections stay reachable (the pre-fix bug terminated pagination when
    // the clamp under-filled the sliced page).
    mockGetAll.mockResolvedValueOnce([
      { id: 10, name: 'A', description: null, read: 'Public', nsfwLevel: 1, userId: 1, user: { id: 1, username: 'a' }, image: null },
      { id: 9, name: 'Mature', description: null, read: 'Public', nsfwLevel: 8, userId: 1, user: { id: 1, username: 'a' }, image: null },
      { id: 8, name: 'B', description: null, read: 'Public', nsfwLevel: 1, userId: 1, user: { id: 1, username: 'a' }, image: null },
      { id: 7, name: 'C', description: null, read: 'Public', nsfwLevel: 1, userId: 1, user: { id: 1, username: 'a' }, image: null },
      { id: 6, name: 'D', description: null, read: 'Public', nsfwLevel: 1, userId: 1, user: { id: 1, username: 'a' }, image: null },
    ]);
    const { req, res } = createMocks({ query: { mode: 'public', limit: '2' } });
    await handler(req as never, res as never);
    const body = res._json() as any;
    // Page filled with the 2 visible collections (10, 8) — the mature 9 dropped.
    expect(body.items.map((i: any) => i.id)).toEqual([10, 8]);
    // Cursor advances to the first unconsumed row (7), NOT terminated early.
    expect(body.nextCursor).toBe(7);
  });

  it('mode=public: exhausted source (fewer than the over-fetch) → no nextCursor', async () => {
    mockGetAll.mockResolvedValueOnce([
      { id: 10, name: 'A', description: null, read: 'Public', nsfwLevel: 1, userId: 1, user: { id: 1, username: 'a' }, image: null },
      { id: 9, name: 'Mature', description: null, read: 'Public', nsfwLevel: 8, userId: 1, user: { id: 1, username: 'a' }, image: null },
      { id: 8, name: 'B', description: null, read: 'Public', nsfwLevel: 1, userId: 1, user: { id: 1, username: 'a' }, image: null },
    ]);
    const { req, res } = createMocks({ query: { mode: 'public', limit: '2' } });
    await handler(req as never, res as never);
    const body = res._json() as any;
    expect(body.items.map((i: any) => i.id)).toEqual([10, 8]);
    expect(body.nextCursor).toBeUndefined();
  });

  it('mode=mine: keyed on the token subject, in-memory name filter + id-DESC keyset (with read:private)', async () => {
    // The private cats are only visible because this token ALSO carries read:private.
    claimsBox.claims = fakeClaims({
      scopes: ['collections:read:self', 'collections:read:private'],
    });
    mockUserCollections.mockResolvedValueOnce([
      { id: 20, name: 'My Cats', description: 'meow', read: 'Private', userId: 42, image: { url: 'c20', type: 'image' } },
      { id: 21, name: 'Dogs', description: null, read: 'Public', userId: 42, image: null },
      { id: 22, name: 'More Cats', description: null, read: 'Private', userId: 42, image: null },
    ]);
    mockItemCount.mockResolvedValueOnce([{ id: 22, count: 3 }, { id: 20, count: 1 }]);
    mockFollowed.mockResolvedValueOnce(new Set<number>());
    const { req, res } = createMocks({ query: { mode: 'mine', query: 'cat', limit: '24' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    const body = res._json() as any;
    // Only the two "cat" collections, id DESC.
    expect(body.items.map((i: any) => i.id)).toEqual([22, 20]);
    expect(mockUserCollections).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ userId: 42 }) })
    );
  });

  it('mode=mine WITHOUT read:private: OMITS the subject\'s non-public collections', async () => {
    // Default claims carry only collections:read:self → private/unlisted are hidden.
    mockUserCollections.mockResolvedValueOnce([
      { id: 20, name: 'Secret', description: null, read: 'Private', userId: 42, image: null },
      { id: 21, name: 'Public Playlist', description: null, read: 'Public', userId: 42, image: null },
      { id: 22, name: 'Unlisted', description: null, read: 'Unlisted', userId: 42, image: null },
    ]);
    mockItemCount.mockResolvedValueOnce([{ id: 21, count: 1 }]);
    mockFollowed.mockResolvedValueOnce(new Set<number>());
    const { req, res } = createMocks({ query: { mode: 'mine', limit: '24' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    const body = res._json() as any;
    // Only the PUBLIC collection is returned; Private + Unlisted are omitted.
    expect(body.items.map((i: any) => i.id)).toEqual([21]);
  });

  it('mode=mine WITH read:private: INCLUDES the subject\'s non-public collections', async () => {
    claimsBox.claims = fakeClaims({
      scopes: ['collections:read:self', 'collections:read:private'],
    });
    mockUserCollections.mockResolvedValueOnce([
      { id: 20, name: 'Secret', description: null, read: 'Private', userId: 42, image: null },
      { id: 21, name: 'Public Playlist', description: null, read: 'Public', userId: 42, image: null },
      { id: 22, name: 'Unlisted', description: null, read: 'Unlisted', userId: 42, image: null },
    ]);
    mockItemCount.mockResolvedValueOnce([]);
    mockFollowed.mockResolvedValueOnce(new Set<number>());
    const { req, res } = createMocks({ query: { mode: 'mine', limit: '24' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    const body = res._json() as any;
    // All three (id DESC) — the read:private scope unlocks the non-public ones.
    expect(body.items.map((i: any) => i.id)).toEqual([22, 21, 20]);
  });

  it('404 when the token subject cannot be hydrated', async () => {
    mockHydrate.mockResolvedValueOnce(null);
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._status()).toBe(404);
  });

  // ---- feedback fixes ----

  it('mode=public: restricts discovery to Image (media) collections (type filter)', async () => {
    mockGetAll.mockResolvedValueOnce([]);
    const { req, res } = createMocks({ query: { mode: 'public', limit: '24' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    // The block list surfaces media collections only — a Model/Article/Post
    // collection would render an empty player, so getAllCollections is passed the
    // Image type filter.
    expect(mockGetAll).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ types: ['Image'] }),
      })
    );
  });

  it('sort=popular alias maps to CollectionSort.MostContributors on the wire', async () => {
    mockGetAll.mockResolvedValueOnce([]);
    const { req, res } = createMocks({ query: { mode: 'public', sort: 'popular' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockGetAll).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ sort: 'Most Followers' }) })
    );
  });

  it('sort=newest alias maps to CollectionSort.Newest', async () => {
    mockGetAll.mockResolvedValueOnce([]);
    const { req, res } = createMocks({ query: { mode: 'public', sort: 'newest' } });
    await handler(req as never, res as never);
    expect(mockGetAll).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ sort: 'Newest' }) })
    );
  });

  it('sort: the raw CollectionSort enum value is still accepted (backward-compat)', async () => {
    mockGetAll.mockResolvedValueOnce([]);
    const { req, res } = createMocks({ query: { mode: 'public', sort: 'Most Followers' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    expect(mockGetAll).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ sort: 'Most Followers' }) })
    );
  });

  it('mode=public: derives a cover from the first item when the collection cover is null', async () => {
    mockGetAll.mockResolvedValueOnce([
      { id: 10, name: 'A', description: null, read: 'Public', nsfwLevel: 0, userId: 1, user: { id: 1, username: 'a' }, image: null },
    ]);
    // The fallback query returns a still-image cover for collection 10.
    mockFallbackCovers.mockResolvedValueOnce(
      new Map([[10, { url: 'first-item-10', type: 'image' }]])
    );
    mockItemCount.mockResolvedValueOnce([{ id: 10, count: 4 }]);
    const { req, res } = createMocks({ query: { mode: 'public', limit: '24' } });
    await handler(req as never, res as never);
    const body = res._json() as any;
    expect(body.items[0].coverImageUrl).toBe('edge:first-item-10');
    // Only the cover-less collection id is passed to the fallback lookup.
    expect(mockFallbackCovers).toHaveBeenCalledWith([10]);
  });

  it('mode=public: a VIDEO first-item cover yields a poster url (not a raw video)', async () => {
    mockGetAll.mockResolvedValueOnce([
      { id: 10, name: 'A', description: null, read: 'Public', nsfwLevel: 0, userId: 1, user: { id: 1, username: 'a' }, image: null },
    ]);
    mockFallbackCovers.mockResolvedValueOnce(
      new Map([[10, { url: 'clip-10', type: 'video' }]])
    );
    mockItemCount.mockResolvedValueOnce([{ id: 10, count: 4 }]);
    const { req, res } = createMocks({ query: { mode: 'public', limit: '24' } });
    await handler(req as never, res as never);
    const body = res._json() as any;
    // toCoverImageUrl renders a video cover as a poster (image), never the .mp4.
    expect(body.items[0].coverImageUrl).toBe('poster:clip-10');
  });

  it('400 returns a STRING error message + flattened details (not a raw ZodError)', async () => {
    // limit 0 fails the .min(1) gate deterministically.
    const { req, res } = createMocks({ query: { mode: 'public', limit: '0' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
    const body = res._json() as any;
    expect(typeof body.error).toBe('string');
    expect(body.error).toBe('Invalid query parameters');
    // flatten() shape: { formErrors, fieldErrors }.
    expect(body.details).toBeTruthy();
    expect(body.details).toHaveProperty('fieldErrors');
  });
});
