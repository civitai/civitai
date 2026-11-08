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
  readTurfRankPage: vi.fn(),
  turfHiddenIds: vi.fn(),
}));

vi.mock('~/server/services/model.service', () => ({ getHeldGalleryLevel: async () => undefined }));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages: mocks.getAllImages,
  getAllImagesIndex: mocks.getAllImagesIndex,
}));
vi.mock('~/server/events/turf/turf-feed', async (importOriginal) => ({
  ...(await importOriginal<typeof TurfFeed>()),
  getHatTurfFeedEvent: mocks.getHatTurfFeedEvent,
  readTurfRankPage: mocks.readTurfRankPage,
  turfHiddenIds: mocks.turfHiddenIds,
}));

import { getInfiniteImagesHandler } from '../image.controller';

const ctx = (features: Record<string, boolean> = {}) =>
  ({
    user: { id: 7, isModerator: false },
    features: { imageIndexFeed: true, hatTurfFeedCard: true, ...features },
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
      input: feed({ hatSort: 'most', hatTeams: ['Blue'] }),
      ctx: ctx(),
    });
    expect(mocks.readTurfRankPage).toHaveBeenCalledWith(
      expect.objectContaining({ event: EVENT, sort: 'most', teams: ['Blue'], limit: 2 })
    );
    expect(mocks.getAllImages.mock.calls[0][0]).toMatchObject({ ids: [30, 10], period: 'AllTime' });
    expect(result.items.map((i) => i.id)).toEqual([30, 10]);
    expect(result.nextCursor).toBe('5|10');
    expect(result.source).toBe('turf');
  });

  it('anyone not playing gets the feed as if no Hat Turf field was sent', async () => {
    mocks.getHatTurfFeedEvent.mockResolvedValue(null);
    const result = await getInfiniteImagesHandler({
      input: feed({ hatSort: 'most', hatTeams: ['Blue'], hideTurfHats: true, hideWornHats: true }),
      ctx: ctx(),
    });
    expect(mocks.readTurfRankPage).not.toHaveBeenCalled();
    expect(mocks.turfHiddenIds).not.toHaveBeenCalled();
    expect(result.items.map((i) => i.id)).toEqual([1, 2]);
    const sent = mocks.getAllImagesIndex.mock.calls[0][0];
    for (const field of ['hatSort', 'hatTeams', 'hideTurfHats', 'hideWornHats'])
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

describe('Show filters on the image feed', () => {
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
