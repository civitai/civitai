import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '~/server/createContext';

vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));

const getReviewImageIds = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/resourceReview.service', () => ({ getReviewImageIds }));

const getInfiniteImagesHandler = vi.hoisted(() => vi.fn());
vi.mock('~/server/controllers/image.controller', () => ({ getInfiniteImagesHandler }));

const { getResourceReviewImagesHandler } = await import(
  '~/server/controllers/resourceReview.controller'
);
const { NsfwLevel } = await import('~/server/common/enums');
const { allBrowsingLevelsFlag, sfwBrowsingLevelsFlag } = await import(
  '~/shared/constants/browsingLevel.constants'
);

const ctxFor = (user?: { id: number; showNsfw: boolean; browsingLevel: number }) =>
  ({ user, features: { canViewNsfw: true } } as unknown as Context);
const input = { reviewId: 7, limit: 4, browsingLevel: allBrowsingLevelsFlag };

beforeEach(() => {
  getReviewImageIds.mockReset();
  getInfiniteImagesHandler.mockReset();
});

describe('getResourceReviewImagesHandler', () => {
  it('hydrates the selected ids through the image feed and returns them in the selected order', async () => {
    getReviewImageIds.mockResolvedValue([3, 1, 2]);
    getInfiniteImagesHandler.mockResolvedValue({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] });

    const result = await getResourceReviewImagesHandler({
      input: { ...input, excludedTagIds: [5], disableMinor: true },
      ctx: ctxFor({ id: 9, showNsfw: true, browsingLevel: sfwBrowsingLevelsFlag }),
    });

    expect(result.items.map((i) => i.id)).toEqual([3, 1, 2]);
    expect(getInfiniteImagesHandler.mock.calls[0][0].input).toMatchObject({
      ids: [3, 1, 2],
      limit: 3,
      excludedTagIds: [5],
      disableMinor: true,
    });
  });

  it('never asks above the viewer’s own level, whatever the client sent', async () => {
    getReviewImageIds.mockResolvedValue([1]);
    getInfiniteImagesHandler.mockResolvedValue({ items: [{ id: 1 }] });
    const viewer = { id: 9, showNsfw: true, browsingLevel: NsfwLevel.PG };

    await getResourceReviewImagesHandler({ input, ctx: ctxFor(viewer) });
    await getResourceReviewImagesHandler({ input, ctx: ctxFor() });

    for (const [call] of getReviewImageIds.mock.calls)
      expect(call.browsingLevel).toBe(NsfwLevel.PG);
    for (const [call] of getInfiniteImagesHandler.mock.calls)
      expect(call.input.browsingLevel).toBe(NsfwLevel.PG);
  });

  it('skips the image read when no image qualifies', async () => {
    getReviewImageIds.mockResolvedValue([]);
    expect(await getResourceReviewImagesHandler({ input, ctx: ctxFor() })).toEqual({ items: [] });
    expect(getInfiniteImagesHandler).not.toHaveBeenCalled();
  });
});
