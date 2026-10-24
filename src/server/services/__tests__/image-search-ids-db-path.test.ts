import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';

/**
 * REGRESSION — an `ids` batch lookup MUST be served from the legacy database
 * path, never from Meili feed search.
 *
 * The defect this pins is silent and returns a 200. `ImagesFeed.queryDocuments`
 * (event-engine-common/feeds/images.feed.ts) does not destructure `ids` and
 * builds no `id IN [...]` filter from it — its sibling `models.feed.ts` DOES
 * (line 558) — so an `ids` key handed to the feed is DROPPED and the caller is
 * served the GLOBAL FEED wearing the caption it asked for. Measured against a
 * dev server on 2026-08-27 and recorded at
 * `src/components/Image/DetailV2/ImageRemixOfDetails.tsx`: asking for
 * `ids: [140383933]` returned image `12097475`.
 *
 * 🔴 NOTE ON THE MEILI COMMENT IN `image-search.service.ts`: the reason is NOT
 * that image id is unindexed. `id` IS a filterable attribute on BOTH image
 * indexes (`metrics-images.search-index.ts` filterableAttributes, and
 * `imagesFilterableAttributes` in `search-index/filterable-attributes.ts` —
 * "`id` is filterable on every index because the keyset cleanup scan pages on
 * it"). The feed's query builder simply never reads `ids`. Either way the
 * observable is the same: the filter is absent from the Meili query.
 *
 * 🔴 ASSERT ON THE RETURNED IDS, NEVER ON THE COUNT. The feed impostor below
 * returns a well-formed image of the right shape and the right length — a test
 * that only checked `items.length` or `res.status === 200` passes while the bug
 * is live. That is the whole reason this file exists.
 */

vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlags: vi.fn(() => ({ canViewNsfw: true, datapacketRead: false })),
  buildFliptContext: vi.fn(() => ({})),
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: {},
  getFliptVariant: vi.fn(async () => 'off'),
}));
vi.mock('~/server/redis/caches', () => ({
  imageMetaCache: { fetch: vi.fn(async () => ({})) },
}));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: vi.fn(() => 'https://edge/x') }));

const feedSearch = vi.fn(async (_input?: unknown) => ({
  items: [] as unknown[],
  nextCursor: undefined as string | undefined,
}));
const legacySearch = vi.fn(async (_input?: unknown) => ({
  items: [] as unknown[],
  nextCursor: undefined as string | undefined,
}));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: (...args: unknown[]) => legacySearch(...(args as [unknown])),
  getAllImagesIndex: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  getImagesFromFeedSearch: (...args: unknown[]) => feedSearch(...(args as [unknown])),
}));

import { runImageSearch } from '../image-search.service';

const req = {
  headers: { 'user-agent': 'probe/1.0' },
  socket: { remoteAddress: '203.0.113.7' },
} as unknown as NextApiRequest;

function image(id: number) {
  return {
    id,
    url: `u-${id}`,
    hash: 'h',
    width: 512,
    height: 768,
    nsfwLevel: 1,
    type: 'image',
    createdAt: new Date(0),
    postId: 369748,
    stats: {},
    user: { id: 4768, username: 'someone' },
    baseModel: 'SD 1.5',
    modelVersionIds: [],
    tags: [],
  };
}

/**
 * The ids a caller asks for, and the ids the GLOBAL FEED would hand back
 * instead. Deliberately disjoint, and deliberately the SAME LENGTH, so only an
 * assertion on the id VALUES can tell the two apart.
 */
const REQUESTED = [140383933, 140383934, 140383935];
const GLOBAL_FEED = [12097475, 12097476, 12097477];

async function run(data: Record<string, unknown>) {
  return runImageSearch(
    { limit: 10, withMeta: false, withTags: false, data } as never,
    {
      browsingLevel: 1,
      user: undefined,
      req,
    } as never
  );
}

describe('runImageSearch — `ids` forces the legacy database path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    feedSearch.mockResolvedValue({ items: GLOBAL_FEED.map(image), nextCursor: undefined });
    legacySearch.mockResolvedValue({ items: REQUESTED.map(image), nextCursor: undefined });
  });

  it('returns the REQUESTED ids, not the global feed', async () => {
    const { items } = await run({ ids: REQUESTED });
    expect(items.map((i) => i.id)).toEqual(REQUESTED);
  });

  it('dispatches an `ids` batch to getAllImages and NEVER to feed search', async () => {
    await run({ ids: REQUESTED });

    expect(legacySearch).toHaveBeenCalledTimes(1);
    expect(feedSearch).not.toHaveBeenCalled();
    // The filter itself must survive the hand-off, not just the routing.
    expect((legacySearch.mock.calls[0][0] as { ids?: number[] }).ids).toEqual(REQUESTED);
  });

  it('routes a single `ids` entry the same way a single `imageId` is routed', async () => {
    legacySearch.mockResolvedValue({ items: [image(REQUESTED[0])], nextCursor: undefined });
    const { items } = await run({ ids: [REQUESTED[0]] });

    expect(feedSearch).not.toHaveBeenCalled();
    expect(items.map((i) => i.id)).toEqual([REQUESTED[0]]);
  });

  it('combines with another DB-forcing filter without falling back to the feed', async () => {
    await run({ ids: REQUESTED, imageId: REQUESTED[0] });
    expect(feedSearch).not.toHaveBeenCalled();
  });

  // ── Scope of the widening: it must not swallow the feed path ────────────────
  // These are INVARIANT GUARDS, not regression coverage — they pin behaviour the
  // bug never violated, so that the fix above cannot over-broaden into "every
  // request goes to the slow DB path".

  it('INVARIANT: a query with no ids/imageId/modelId still uses feed search', async () => {
    const { items } = await run({ sort: 'Newest' });
    expect(legacySearch).not.toHaveBeenCalled();
    expect(feedSearch).toHaveBeenCalledTimes(1);
    expect(items.map((i) => i.id)).toEqual(GLOBAL_FEED);
  });

  it('INVARIANT: `imageId` alone still uses the legacy path', async () => {
    await run({ imageId: REQUESTED[0] });
    expect(legacySearch).toHaveBeenCalledTimes(1);
    expect(feedSearch).not.toHaveBeenCalled();
  });

  it('INVARIANT: an EMPTY ids array is not a batch — it stays on the feed path', async () => {
    // The REST schemas reject `ids` with fewer than one entry, so this shape
    // cannot arrive from either endpoint. Pinned anyway because the predicate is
    // shared: an empty array must not silently become "every image in the DB",
    // which is what a truthiness check (`data.ids ? ...`) would produce.
    await run({ ids: [] });
    expect(legacySearch).not.toHaveBeenCalled();
    expect(feedSearch).toHaveBeenCalledTimes(1);
  });
});
