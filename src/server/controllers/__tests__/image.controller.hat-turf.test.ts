import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '~/server/createContext';
import type * as ImageService from '~/server/services/image.service';
import type * as TurfFeed from '~/server/events/turf/turf-feed';

/**
 * The Hat Turf sorts and Show filters on the image feed: served to players only, and to anyone else
 * as if never asked for. The indexes and reads themselves are in turf-feed.pglite.test.ts.
 */

const mocks = vi.hoisted(() => ({
  getAllImages: vi.fn(),
  getAllImagesIndex: vi.fn(),
  getHatTurfFeedEvent: vi.fn(),
  readMyTurfPage: vi.fn(),
  readTurfRankPage: vi.fn(),
  turfHiddenIds: vi.fn(),
  getUserFollows: vi.fn(),
}));

// Post 9's model is held at PG (1).
vi.mock('~/server/services/model.service', () => ({
  getHeldGalleryLevel: async () => undefined,
  getHeldLevelsByPost: async (postIds: number[]) =>
    new Map(postIds.filter((id) => id === 9).map((id) => [id, { level: 1, ownerId: 99 }])),
  isModelGalleryWithheld: async () => false,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserFollows: mocks.getUserFollows,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages: mocks.getAllImages,
  getAllImagesIndex: mocks.getAllImagesIndex,
}));
vi.mock('~/server/events/turf/turf-feed', async (importOriginal) => ({
  ...(await importOriginal<typeof TurfFeed>()),
  getHatTurfFeedEvent: mocks.getHatTurfFeedEvent,
  readMyTurfPage: mocks.readMyTurfPage,
  readTurfRankPage: mocks.readTurfRankPage,
  turfHiddenIds: mocks.turfHiddenIds,
}));

import { getInfiniteImagesHandler } from '../image.controller';

const ctx = (features: Record<string, boolean> = {}) =>
  ({
    user: { id: 7, isModerator: false },
    features: { imageIndexFeed: true, hatTurfFeedCard: true, hatTurfFeedSorts: true, ...features },
    req: { headers: {} },
    ip: '127.0.0.1',
  } as unknown as Context);
const EVENT = { name: 'e', teams: ['Blue', 'Pink'] };
const feed = (extra: Record<string, unknown> = {}) =>
  ({ limit: 2, browsingLevel: 1, include: [], ...extra } as never);
const rows = (...ids: number[]) => ids.map((id) => ({ id }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getHatTurfFeedEvent.mockResolvedValue(EVENT);
  mocks.getAllImagesIndex.mockResolvedValue({
    nextCursor: 'next',
    items: rows(1, 2),
    source: 'meili',
  });
  mocks.getAllImages.mockResolvedValue({ nextCursor: undefined, items: [] });
  mocks.turfHiddenIds.mockResolvedValue(new Set());
});

describe('Hat Turf sorts on the image feed', () => {
  it('a player gets the page in rank order, hydrated by id', async () => {
    mocks.readTurfRankPage.mockResolvedValue({ ids: [30, 10], nextCursor: '5|10' });
    // The hydrate answers in its own order.
    mocks.getAllImages.mockResolvedValue({ items: rows(10, 30) });
    const result = await getInfiniteImagesHandler({
      input: feed({ hatSort: 'most', hatTeams: ['Blue'], excludedUserIds: [5] }),
      ctx: ctx(),
    });
    expect(mocks.readTurfRankPage).toHaveBeenCalledWith(
      expect.objectContaining({ event: EVENT, sort: 'most', teams: ['Blue'], limit: 2 })
    );
    // The viewer's own filters and identity reach the hydrate: it is the only filter on this path.
    expect(mocks.getAllImages.mock.calls[0][0]).toMatchObject({
      ids: [30, 10],
      period: 'AllTime',
      browsingLevel: 1,
      excludedUserIds: [5],
      user: { id: 7 },
    });
    expect(result.items.map((i) => i.id)).toEqual([30, 10]);
    expect(result.nextCursor).toBe('5|10');
    expect(result.source).toBe('turf');
  });

  it("drops an image held at its model's level, as the feed does for images picked by id", async () => {
    mocks.readTurfRankPage.mockResolvedValue({ ids: [10, 11], nextCursor: undefined });
    mocks.getAllImages.mockResolvedValue({
      items: [
        { id: 10, postId: 9, nsfwLevel: 4 },
        { id: 11, postId: 9, nsfwLevel: 1 },
      ],
    });
    const result = await getInfiniteImagesHandler({ input: feed({ hatSort: 'most' }), ctx: ctx() });
    expect(result.items.map((i) => i.id)).toEqual([11]);
  });

  it('Following with nobody followed is an empty page, as on the normal feed', async () => {
    mocks.getUserFollows.mockResolvedValue([]);
    mocks.readTurfRankPage.mockResolvedValue({ ids: [10], nextCursor: undefined });
    mocks.getAllImages.mockResolvedValue({ items: rows(10) });
    const result = await getInfiniteImagesHandler({
      input: feed({ hatSort: 'most', followed: true }),
      ctx: ctx(),
    });
    expect(result.items).toEqual([]);
    mocks.getUserFollows.mockResolvedValue([3]);
    const followed = await getInfiniteImagesHandler({
      input: feed({ hatSort: 'most', followed: true }),
      ctx: ctx(),
    });
    expect(followed.items.map((i) => i.id)).toEqual([10]);
  });

  it('anyone not playing gets the feed as if no Hat Turf field was sent', async () => {
    mocks.getHatTurfFeedEvent.mockResolvedValue(null);
    const result = await getInfiniteImagesHandler({
      input: feed({
        hatSort: 'most',
        hatTeams: ['Blue'],
        hatTurfMine: true,
        hideTurfHats: true,
        hideWornHats: true,
      }),
      ctx: ctx(),
    });
    expect(mocks.readTurfRankPage).not.toHaveBeenCalled();
    expect(mocks.readMyTurfPage).not.toHaveBeenCalled();
    expect(mocks.turfHiddenIds).not.toHaveBeenCalled();
    expect(result.items.map((i) => i.id)).toEqual([1, 2]);
    const sent = mocks.getAllImagesIndex.mock.calls[0][0];
    for (const field of ['hatSort', 'hatTeams', 'hatTurfMine', 'hideTurfHats', 'hideWornHats'])
      expect(sent).not.toHaveProperty(field);
  });

  it('with the feed-card flag off, the player is not even looked up', async () => {
    await getInfiniteImagesHandler({
      input: feed({ hatSort: 'most' }),
      ctx: ctx({ hatTurfFeedCard: false }),
    });
    expect(mocks.getHatTurfFeedEvent).not.toHaveBeenCalled();
    expect(mocks.readTurfRankPage).not.toHaveBeenCalled();
  });

  // Deliberate: hat-turf-feed-card is at 100%, so this flag is what holds the sorts and Show filters
  // to testers. Do not fold it into hatTurfFeedCard until the sorts roll out to everyone.
  it('with the feed-sorts flag off, a player gets the normal feed, whatever Hat Turf fields they send', async () => {
    const result = await getInfiniteImagesHandler({
      input: feed({
        hatSort: 'most',
        hatTeams: ['Blue'],
        hatTurfMine: true,
        hideTurfHats: true,
        hideWornHats: true,
      }),
      ctx: ctx({ hatTurfFeedSorts: false }),
    });
    expect(mocks.getHatTurfFeedEvent).not.toHaveBeenCalled();
    expect(mocks.readTurfRankPage).not.toHaveBeenCalled();
    expect(mocks.readMyTurfPage).not.toHaveBeenCalled();
    expect(mocks.turfHiddenIds).not.toHaveBeenCalled();
    expect(result.items.map((i) => i.id)).toEqual([1, 2]);
  });

  it('a feed with no Hat Turf field never looks the player up', async () => {
    await getInfiniteImagesHandler({ input: feed(), ctx: ctx() });
    expect(mocks.getHatTurfFeedEvent).not.toHaveBeenCalled();
  });

  it("a model's gallery ignores the sort: the hydrate would drop the model and serve every image", async () => {
    await getInfiniteImagesHandler({ input: feed({ hatSort: 'most', modelId: 5 }), ctx: ctx() });
    expect(mocks.readTurfRankPage).not.toHaveBeenCalled();
    // Served by the gallery's own path, with the model kept.
    const [served] = [...mocks.getAllImagesIndex.mock.calls, ...mocks.getAllImages.mock.calls];
    expect(served[0]).toMatchObject({ modelId: 5 });
  });
});

describe("the viewer's own live hats on the image feed", () => {
  const placed = new Date('2026-11-09T10:00:00Z');
  beforeEach(() => {
    mocks.readMyTurfPage.mockResolvedValue({
      ids: [30, 10],
      placedAt: new Map([
        [10, placed],
        [30, placed],
      ]),
      nextCursor: '1|10',
    });
    mocks.getAllImages.mockResolvedValue({ items: rows(10, 30) });
  });

  it('a player gets their own hats in the order read, every media type, each with when it was placed', async () => {
    const result = await getInfiniteImagesHandler({
      input: feed({ hatTurfMine: true, types: ['image'] }),
      ctx: ctx(),
    });
    expect(mocks.readMyTurfPage).toHaveBeenCalledWith(
      expect.objectContaining({ event: EVENT, userId: 7, sort: undefined, limit: 2 })
    );
    expect(mocks.readTurfRankPage).not.toHaveBeenCalled();
    const hydrate = mocks.getAllImages.mock.calls[0][0];
    expect(hydrate).toMatchObject({ ids: [30, 10], user: { id: 7 } });
    expect(hydrate.types).toBeUndefined();
    expect(result.items).toEqual([
      { id: 30, turfPlacedAt: placed },
      { id: 10, turfPlacedAt: placed },
    ]);
    expect(result.nextCursor).toBe('1|10');
    expect(result.source).toBe('turf');
  });

  it('a Hat Turf sort and its teams rank their own hats, and the rank sort is not read', async () => {
    await getInfiniteImagesHandler({
      input: feed({ hatTurfMine: true, hatSort: 'fewest', hatTeams: ['Pink'] }),
      ctx: ctx(),
    });
    expect(mocks.readMyTurfPage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, sort: 'fewest', teams: ['Pink'] })
    );
    expect(mocks.readTurfRankPage).not.toHaveBeenCalled();
  });

  it('a Hat Turf sort alone leaves the images with no placed time', async () => {
    mocks.readTurfRankPage.mockResolvedValue({ ids: [10], nextCursor: undefined });
    mocks.getAllImages.mockResolvedValue({ items: rows(10) });
    const result = await getInfiniteImagesHandler({ input: feed({ hatSort: 'most' }), ctx: ctx() });
    expect(result.items.map((i) => i.id)).toEqual([10]);
    expect(result.items[0]).not.toHaveProperty('turfPlacedAt');
  });

  // Deliberate: every image in this view wears the viewer's live Turf hat, so "Turf hats" off would
  // empty it. Only the worn-hat filter applies.
  it('only the worn-hat filter applies', async () => {
    await getInfiniteImagesHandler({
      input: feed({ hatTurfMine: true, hideTurfHats: true, hideWornHats: true }),
      ctx: ctx(),
    });
    expect(mocks.turfHiddenIds).toHaveBeenCalledWith(EVENT, [30, 10], {
      turf: undefined,
      worn: true,
    });
  });

  it("a scoped feed ignores it, and serves the gallery's own images", async () => {
    await getInfiniteImagesHandler({ input: feed({ hatTurfMine: true, modelId: 5 }), ctx: ctx() });
    expect(mocks.readMyTurfPage).not.toHaveBeenCalled();
    const [served] = [...mocks.getAllImagesIndex.mock.calls, ...mocks.getAllImages.mock.calls];
    expect(served[0]).toMatchObject({ modelId: 5 });
  });
});

describe('Show filters on the image feed', () => {
  // Deliberate: the Show filters live in the shared images filter store, so a player who hid hats on
  // /images would otherwise see images silently missing from a profile or a model's gallery.
  it.each([{ modelId: 5 }, { username: 'creator' }, { postId: 9 }])(
    'a scoped feed (%o) ignores them, and serves every image',
    async (scope) => {
      // Both images wear hats, whichever path serves the gallery.
      mocks.getAllImages.mockResolvedValue({ nextCursor: undefined, items: rows(1, 2) });
      mocks.turfHiddenIds.mockResolvedValue(new Set([1, 2]));
      const result = await getInfiniteImagesHandler({
        input: feed({ hideTurfHats: true, hideWornHats: true, ...scope }),
        ctx: ctx(),
      });
      expect(result.items.map((i) => i.id)).toEqual([1, 2]);
      expect(mocks.turfHiddenIds).not.toHaveBeenCalled();
      const [served] = [...mocks.getAllImagesIndex.mock.calls, ...mocks.getAllImages.mock.calls];
      expect(served[0]).toMatchObject(scope);
    }
  );

  // Deliberate: every image under a Hat Turf sort has Turf hats, so "Turf hats" off there would
  // empty the feed for a player who turned it off earlier. Only the worn-hat filter applies.
  it('under a Hat Turf sort, only the worn-hat filter applies', async () => {
    mocks.readTurfRankPage.mockResolvedValue({ ids: [10], nextCursor: undefined });
    mocks.getAllImages.mockResolvedValue({ items: rows(10) });
    const result = await getInfiniteImagesHandler({
      input: feed({ hatSort: 'most', hideTurfHats: true, hideWornHats: true }),
      ctx: ctx(),
    });
    expect(mocks.turfHiddenIds).toHaveBeenCalledWith(EVENT, [10], { turf: undefined, worn: true });
    expect(result.items.map((i) => i.id)).toEqual([10]);
  });

  it('drops hidden images and reads on, three reads at most, from each cursor in turn', async () => {
    mocks.getAllImagesIndex
      .mockResolvedValueOnce({ nextCursor: 'b', items: rows(1, 2), source: 'meili' })
      .mockResolvedValueOnce({ nextCursor: 'c', items: rows(3, 4), source: 'meili' })
      .mockResolvedValueOnce({ nextCursor: 'd', items: rows(5, 6), source: 'meili' });
    // Everything but image 3 wears a hat.
    mocks.turfHiddenIds.mockImplementation(
      async (_e: unknown, ids: number[]) => new Set(ids.filter((id) => id !== 3))
    );
    const result = await getInfiniteImagesHandler({
      input: feed({ hideTurfHats: true, hideWornHats: true }),
      ctx: ctx(),
    });
    expect(mocks.turfHiddenIds).toHaveBeenCalledWith(EVENT, [1, 2], { turf: true, worn: true });
    expect(mocks.getAllImagesIndex.mock.calls.map((c) => c[0].cursor)).toEqual([
      undefined,
      'b',
      'c',
    ]);
    expect(result.items.map((i) => i.id)).toEqual([3]);
    expect(result.nextCursor).toBe('d');
  });

  it('with both shown (no hide field), pages are not filtered', async () => {
    const result = await getInfiniteImagesHandler({
      input: feed({ hideTurfHats: false }),
      ctx: ctx(),
    });
    expect(mocks.turfHiddenIds).not.toHaveBeenCalled();
    expect(result.items.map((i) => i.id)).toEqual([1, 2]);
  });
});
