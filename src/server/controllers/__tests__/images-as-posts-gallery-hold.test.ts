import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ImageService from '~/server/services/image.service';
import {
  allBrowsingLevelsFlag,
  nsfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { NsfwLevel } from '~/server/common/enums';

const { fetches, heldLevel } = vi.hoisted(() => ({
  fetches: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  heldLevel: vi.fn(),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages: fetches,
  getAllImagesIndex: fetches,
  filterPinnedImagesToVersion: async (images: unknown[]) => images,
}));
vi.mock('~/server/services/model.service', () => ({
  getGallerySettingsByModelId: async () => ({ pinnedPosts: { 10: [100] }, hiddenImages: {} }),
  getHeldGalleryLevel: heldLevel,
}));
vi.mock('~/server/services/promotion.service', () => ({
  getSponsoredGalleryPost: async () => ({
    postId: 200,
    imageIds: [],
    servingLevel: allBrowsingLevelsFlag,
  }),
}));

const { getImagesAsPostsInfiniteHandler } = await import('~/server/controllers/image.controller');

function run(browsingLevel: number, isModerator = false, subject?: unknown) {
  return getImagesAsPostsInfiniteHandler({
    input: {
      limit: 10,
      modelId: 1,
      modelVersionId: 10,
      include: [],
      browsingLevel,
      preCapBrowsingLevel: browsingLevel,
    } as never,
    ctx: { user: { id: 5, isModerator }, subject, features: {}, req: { headers: {} } } as never,
  });
}

function fetchedLevels() {
  const calls = fetches.mock.calls.map(
    (c) => (c as unknown as [{ postIds?: number[]; browsingLevel?: number }])[0]
  );
  return {
    pinned: calls.find((c) => c.postIds?.includes(100))?.browsingLevel,
    sponsored: calls.find((c) => c.postIds?.includes(200))?.browsingLevel,
    page: calls.find((c) => !c.postIds)?.browsingLevel,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.resourceReview.findMany.mockResolvedValue([] as never);
});

describe('getImagesAsPostsInfiniteHandler on a held gallery', () => {
  it('serves the page, pinned and sponsored posts at the held level, whatever is asked', async () => {
    heldLevel.mockResolvedValue(NsfwLevel.PG);

    await run(allBrowsingLevelsFlag);

    expect(heldLevel).toHaveBeenCalledWith(expect.objectContaining({ modelVersionId: 10 }));
    expect(fetchedLevels()).toEqual({
      pinned: NsfwLevel.PG,
      sponsored: NsfwLevel.PG,
      page: NsfwLevel.PG,
    });
  });

  it('returns an empty gallery, fetching nothing, when no asked level is held', async () => {
    heldLevel.mockResolvedValue(NsfwLevel.PG);

    const result = await run(nsfwBrowsingLevelsFlag);

    expect(result.items).toEqual([]);
    expect(fetches).not.toHaveBeenCalled();
  });

  it('serves nothing when the held models allow no level in common', async () => {
    heldLevel.mockResolvedValue(0);

    const result = await run(allBrowsingLevelsFlag);

    expect(result.items).toEqual([]);
    expect(fetches).not.toHaveBeenCalled();
  });

  it('serves a moderator the whole gallery, where a non-moderator is held', async () => {
    heldLevel.mockResolvedValue(NsfwLevel.PG);

    await run(allBrowsingLevelsFlag, true);
    const moderator = fetchedLevels();
    vi.clearAllMocks();
    await run(allBrowsingLevelsFlag);

    expect(moderator.page).toBe(allBrowsingLevelsFlag);
    expect(fetchedLevels().page).toBe(NsfwLevel.PG);
  });

  it('holds a moderator who comes through an app they authorised', async () => {
    heldLevel.mockResolvedValue(NsfwLevel.PG);

    await run(allBrowsingLevelsFlag, true, { type: 'oauth', id: 'app' });

    expect(fetchedLevels().page).toBe(NsfwLevel.PG);
  });

  it('leaves an unheld gallery at the level asked for', async () => {
    heldLevel.mockResolvedValue(undefined);

    await run(allBrowsingLevelsFlag);

    expect(fetchedLevels()).toEqual({
      pinned: allBrowsingLevelsFlag,
      sponsored: allBrowsingLevelsFlag,
      page: allBrowsingLevelsFlag,
    });
  });
});
