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
  // REAL bitwise semantics (Flags.intersects OR unrated 0) — NOT a `<=` — so the
  // maturity clamp on covers is exercised faithfully: a MIXED bucket (29) still
  // intersects a SFW ceiling (3), and a mature bucket (28) does NOT (28 & 3 = 0).
  collectionWithinCeiling: (nsfwLevel: number, level: number) =>
    !nsfwLevel || (nsfwLevel & level) !== 0,
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({ checkBlockCatalogRateLimit: mockRate }));
vi.mock('~/server/utils/block-catalog-maturity', () => ({
  resolveCatalogBrowsingLevel: mockMaturity,
}));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => ({}),
  isRegionRestricted: () => false,
}));

import handler, {
  MIN_PLAYABLE_FRACTION,
  meetsPlayableFloor,
} from '~/pages/api/v1/blocks/collections/index';

/**
 * Drive the TWO count queries the public branch issues — the ADVERTISED count
 * (no `browsingLevel`) and the PLAYABLE one (clamped to the token's ceiling) —
 * from two id→count tables.
 *
 * Dispatching on `browsingLevel` rather than on call order matters: the two are
 * issued inside one `Promise.all`, so a `mockResolvedValueOnce` pair would pin
 * the order they happen to be listed in and pass just as happily if the endpoint
 * swapped which number it advertises.
 *
 * An id ABSENT from a table yields NO ROW, exactly as `GROUP BY` does for a
 * collection with nothing to count — which is the shape the zero-advertised case
 * below depends on.
 */
function itemCounts(advertised: Record<number, number>, playable: Record<number, number>) {
  mockItemCount.mockImplementation(
    ({ collectionIds, browsingLevel }: { collectionIds: number[]; browsingLevel?: number }) => {
      const table = browsingLevel === undefined ? advertised : playable;
      return Promise.resolve(
        collectionIds.filter((id) => table[id] != null).map((id) => ({ id, count: table[id] }))
      );
    }
  );
}

/** A discovery row at the given id; `nsfw` 29 is the live mixed-bucket shape. */
const row = (id: number, nsfw = 29) => ({
  id,
  name: `C${id}`,
  description: null,
  read: 'Public',
  nsfwLevel: nsfw,
  userId: 1,
  user: { id: 1, username: 'a' },
  image: null,
});

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
    // Only the cover-less collection id is passed to the fallback lookup, WITH the
    // token's clamped browsingLevel (3) so the fallback query filters by maturity.
    expect(mockFallbackCovers).toHaveBeenCalledWith([10], 3);
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

  it('mode=public: a MATURE primary cover is clamped out → uses the clamped fallback (no mature-thumbnail leak)', async () => {
    // Collection nsfwLevel 1 passes the discovery gate, but its OWN cover image is
    // mature (bucket 28). On a SFW ceiling (3): 28 & 3 === 0 → the primary cover
    // must be rejected and replaced by the maturity-clamped fallback item.
    mockGetAll.mockResolvedValueOnce([
      {
        id: 10,
        name: 'A',
        description: null,
        read: 'Public',
        nsfwLevel: 1,
        userId: 1,
        user: { id: 1, username: 'a' },
        image: { url: 'mature-cover', type: 'image', nsfwLevel: 28 },
      },
    ]);
    mockFallbackCovers.mockResolvedValueOnce(new Map([[10, { url: 'sfw-item', type: 'image' }]]));
    mockItemCount.mockResolvedValueOnce([{ id: 10, count: 3 }]);
    const { req, res } = createMocks({ query: { mode: 'public', limit: '24' } });
    await handler(req as never, res as never);
    const body = res._json() as any;
    // NEVER the mature primary cover.
    expect(body.items[0].coverImageUrl).toBe('edge:sfw-item');
    expect(body.items[0].coverImageUrl).not.toBe('edge:mature-cover');
    // The cover-less-after-clamp id is sent to the fallback WITH browsingLevel 3.
    expect(mockFallbackCovers).toHaveBeenCalledWith([10], 3);
  });

  it('mode=public: a MIXED-bucket (29) collection passes the gate but its cover is CLAMPED via the fallback', async () => {
    // 29 & 3 === 1 → the mixed collection passes discovery. Cover is null, so it
    // takes the fallback — which is threaded browsingLevel so the query returns the
    // newest PERMITTED (SFW) item, never the mature newest one.
    mockGetAll.mockResolvedValueOnce([
      {
        id: 10,
        name: 'Mixed',
        description: null,
        read: 'Public',
        nsfwLevel: 29,
        userId: 1,
        user: { id: 1, username: 'a' },
        image: null,
      },
    ]);
    mockFallbackCovers.mockResolvedValueOnce(new Map([[10, { url: 'sfw-item', type: 'image' }]]));
    mockItemCount.mockResolvedValueOnce([{ id: 10, count: 5 }]);
    const { req, res } = createMocks({ query: { mode: 'public', limit: '24' } });
    await handler(req as never, res as never);
    const body = res._json() as any;
    // The mixed collection IS surfaced (passes the bitwise gate)…
    expect(body.items.map((i: any) => i.id)).toEqual([10]);
    // …but its cover comes from the maturity-clamped fallback.
    expect(body.items[0].coverImageUrl).toBe('edge:sfw-item');
    expect(mockFallbackCovers).toHaveBeenCalledWith([10], 3);
  });

  it('mode=public: a SFW primary cover within the ceiling is used directly (no fallback)', async () => {
    mockGetAll.mockResolvedValueOnce([
      {
        id: 10,
        name: 'A',
        description: null,
        read: 'Public',
        nsfwLevel: 1,
        userId: 1,
        user: { id: 1, username: 'a' },
        image: { url: 'sfw-cover', type: 'image', nsfwLevel: 1 },
      },
    ]);
    mockItemCount.mockResolvedValueOnce([{ id: 10, count: 1 }]);
    const { req, res } = createMocks({ query: { mode: 'public', limit: '24' } });
    await handler(req as never, res as never);
    const body = res._json() as any;
    expect(body.items[0].coverImageUrl).toBe('edge:sfw-cover');
    // Nothing needed the fallback (primary within ceiling).
    expect(mockFallbackCovers).toHaveBeenCalledWith([], 3);
  });

  // ---- playable-fraction floor + clamped itemCount ----
  //
  // The problem these cover: a collection's own `nsfwLevel` is a bitmask OR-ed
  // over its items, so a 97%-safe contest collection and a 1%-safe mature one
  // carry the identical value and both pass the bitwise ceiling. What separates
  // them is how much of the collection SURVIVES the ceiling — which discovery did
  // not compute, so a card advertised the unclamped total while the player served
  // the clamped one.

  it('mode=public: DROPS a collection below the playable floor and keeps one above it', async () => {
    // Both are mixed-bucket (29) and both pass the ceiling — the whole point is
    // that the collection-level level cannot tell them apart.
    mockGetAll.mockResolvedValueOnce([row(10), row(11)]);
    itemCounts(
      { 10: 2078, 11: 34577 }, // advertised
      { 10: 216, 11: 33500 } //   playable: 10.4% vs 96.9%
    );
    const { req, res } = createMocks({ query: { mode: 'public', limit: '24' } });
    await handler(req as never, res as never);
    const body = res._json() as any;
    expect(body.items.map((i: any) => i.id)).toEqual([11]);
    // …and the surviving card advertises the CLAMPED count, not the 34577 the
    // player cannot serve.
    expect(body.items[0].itemCount).toBe(33500);
  });

  it('mode=public: the boundary — EXACTLY at the floor is kept, one item below is dropped', async () => {
    // 20/100 === MIN_PLAYABLE_FRACTION → kept (the test is `>=`, not `>`).
    // 19/100 <  MIN_PLAYABLE_FRACTION → dropped.
    // Derived from the constant so the pair moves with it rather than pinning 0.2.
    const advertised = 100;
    const atFloor = Math.round(advertised * MIN_PLAYABLE_FRACTION);
    mockGetAll.mockResolvedValueOnce([row(10), row(11)]);
    itemCounts({ 10: advertised, 11: advertised }, { 10: atFloor, 11: atFloor - 1 });
    const { req, res } = createMocks({ query: { mode: 'public', limit: '24' } });
    await handler(req as never, res as never);
    const body = res._json() as any;
    expect(body.items.map((i: any) => i.id)).toEqual([10]);
  });

  it('mode=public: a collection advertising ZERO items is NOT dropped (no 0/0 NaN drop)', async () => {
    // Neither id appears in either table → both counts are 0, and `0 / 0` is NaN,
    // which fails every comparison. Without the explicit zero branch this row is
    // silently dropped by a filter that has nothing to say about it.
    mockGetAll.mockResolvedValueOnce([row(10)]);
    itemCounts({}, {});
    const { req, res } = createMocks({ query: { mode: 'public', limit: '24' } });
    await handler(req as never, res as never);
    const body = res._json() as any;
    expect(body.items.map((i: any) => i.id)).toEqual([10]);
    expect(body.items[0].itemCount).toBe(0);
  });

  it('🔴 mode=public: a page where EVERY row is dropped by the floor still ADVANCES the cursor', async () => {
    // limit 1 → OVERFETCH 5. Returning exactly 5 rows, all below the floor, is the
    // "filtered to empty" page. Filtering AFTER the slice would emit no cursor here
    // and terminate the feed while qualifying collections remained further down.
    const rows = [row(10), row(9), row(8), row(7), row(6)];
    mockGetAll.mockResolvedValueOnce(rows);
    itemCounts(
      { 10: 100, 9: 100, 8: 100, 7: 100, 6: 100 },
      { 10: 1, 9: 1, 8: 1, 7: 1, 6: 1 } // 1% — every one below the floor
    );
    const { req, res } = createMocks({ query: { mode: 'public', limit: '1' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    const body = res._json() as any;
    // A short (here: empty) page is the accepted cost…
    expect(body.items).toEqual([]);
    // …but the feed MUST stay walkable. Resume from the last fetched row.
    expect(body.nextCursor).toBe(6);
  });

  it('mode=public: counts are resolved over the CEILING-PASSING candidates, before the page is chosen', async () => {
    // The floor decides which rows the page consumes, so both counts must cover
    // every row that could still appear — not just the ones that survived. Id 9 is
    // dropped by the floor yet must have been COUNTED, or the floor could not have
    // dropped it; id 8 is over the ceiling (8 & 3 === 0) and must NOT be counted,
    // since it can never appear.
    mockGetAll.mockResolvedValueOnce([row(10), row(9), row(8, 8)]);
    itemCounts({ 10: 100, 9: 100 }, { 10: 90, 9: 1 });
    const { req, res } = createMocks({ query: { mode: 'public', limit: '24' } });
    await handler(req as never, res as never);
    const body = res._json() as any;
    expect(body.items.map((i: any) => i.id)).toEqual([10]);

    const calls = mockItemCount.mock.calls.map((c: any[]) => c[0]);
    // Exactly two count queries: one advertised, one clamped to the token ceiling.
    expect(calls).toHaveLength(2);
    const advertisedCall = calls.find((a: any) => a.browsingLevel === undefined);
    const playableCall = calls.find((a: any) => a.browsingLevel !== undefined);
    expect(advertisedCall).toBeTruthy();
    expect(playableCall.browsingLevel).toBe(3);
    for (const call of calls) {
      expect(call.collectionIds).toEqual([10, 9]);
      expect(call.status).toBe('ACCEPTED');
    }
  });

  it('🔴 mode=mine: a collection FAR below the floor is STILL RETURNED (the floor is discovery-only)', async () => {
    // The subject put these in their own list. Hiding one for being mostly mature
    // makes it look deleted — the defect class the detail surface already settled
    // the other way (empty own-collection → disabled WITH A REASON, never hidden).
    claimsBox.claims = fakeClaims({
      scopes: ['collections:read:self', 'collections:read:private'],
    });
    mockUserCollections.mockResolvedValueOnce([
      { id: 20, name: 'Mine, mostly mature', description: null, read: 'Private', userId: 42, image: null },
      { id: 21, name: 'Mine, mostly safe', description: null, read: 'Public', userId: 42, image: null },
    ]);
    itemCounts({ 20: 2080, 21: 100 }, { 20: 19, 21: 90 }); // 0.9% and 90%
    mockFollowed.mockResolvedValueOnce(new Set<number>());
    const { req, res } = createMocks({ query: { mode: 'mine', limit: '24' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    const body = res._json() as any;
    // BOTH, id DESC — the 0.9% one is not dropped.
    expect(body.items.map((i: any) => i.id)).toEqual([21, 20]);
  });

  it('mode=mine: itemCount is CLAMPED (the count is wanted in both modes, only the DROP is not)', async () => {
    mockUserCollections.mockResolvedValueOnce([
      { id: 21, name: 'Mine', description: null, read: 'Public', userId: 42, image: null },
    ]);
    itemCounts({ 21: 2080 }, { 21: 19 });
    mockFollowed.mockResolvedValueOnce(new Set<number>());
    const { req, res } = createMocks({ query: { mode: 'mine', limit: '24' } });
    await handler(req as never, res as never);
    const body = res._json() as any;
    // 19, the number the player will serve — NOT the 2080 the card used to promise.
    expect(body.items[0].itemCount).toBe(19);
    // One count query on this branch, and it carries the ceiling.
    const calls = mockItemCount.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0].browsingLevel).toBe(3);
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

describe('meetsPlayableFloor', () => {
  it('an empty collection is KEPT — the fraction is not computable, not "zero"', () => {
    // `0 / 0` is NaN and every NaN comparison is false, so the absence of this
    // branch is a silent drop rather than a visible error.
    expect(meetsPlayableFloor(0, 0)).toBe(true);
    // Defensive: a negative advertised count can only come from a corrupt read,
    // and must not be treated as a mismatch either.
    expect(meetsPlayableFloor(-1, 0)).toBe(true);
  });

  it('is inclusive at the floor and exclusive below it', () => {
    expect(meetsPlayableFloor(100, Math.round(100 * MIN_PLAYABLE_FRACTION))).toBe(true);
    expect(meetsPlayableFloor(100, Math.round(100 * MIN_PLAYABLE_FRACTION) - 1)).toBe(false);
  });

  it('is a FRACTION, not an absolute count', () => {
    // The live shape the floor is aimed at: a huge collection with a large absolute
    // playable count is still mostly unplayable. Any threshold on `playable` alone
    // would keep this (216 items is plenty) and would be the wrong rule.
    expect(meetsPlayableFloor(2078, 216)).toBe(false);
    // …while a tiny collection that is entirely playable passes on 5 items.
    expect(meetsPlayableFloor(5, 5)).toBe(true);
  });

  it('a fully playable collection always passes, at any size', () => {
    expect(meetsPlayableFloor(1, 1)).toBe(true);
    expect(meetsPlayableFloor(34577, 34577)).toBe(true);
  });

  it('MIN_PLAYABLE_FRACTION is a fraction in (0, 1]', () => {
    // Pins the UNITS. A value expressed as a percentage (20) instead of a fraction
    // (0.2) would make the floor unreachable and empty public discovery entirely,
    // while every relative test above — which derives its fixtures from the
    // constant — would keep passing.
    expect(MIN_PLAYABLE_FRACTION).toBeGreaterThan(0);
    expect(MIN_PLAYABLE_FRACTION).toBeLessThanOrEqual(1);
  });
});
