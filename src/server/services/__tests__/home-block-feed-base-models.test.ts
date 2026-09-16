import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeBlockType } from '~/shared/utils/prisma/enums';
// Module scope for the same reason as home-block-fetch-sizing.test.ts: from a test body this
// graph's transform is charged to one test's 60s budget.
import { getHomeBlockData } from '~/server/services/home-block.service';
import type * as ImageService from '~/server/services/image.service';
import type * as ModelService from '~/server/services/model.service';

const { getAllImagesIndexMock, getModelsWithImagesAndModelVersionsMock, getFeaturedModelsMock } =
  vi.hoisted(() => ({
    getAllImagesIndexMock: vi.fn(async () => ({ items: [], nextCursor: undefined })),
    getModelsWithImagesAndModelVersionsMock: vi.fn(async () => ({ items: [] })),
    getFeaturedModelsMock: vi.fn(async () => [{ modelId: 1 }]),
  }));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImagesIndex: getAllImagesIndexMock,
}));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModelsWithImagesAndModelVersions: getModelsWithImagesAndModelVersionsMock,
  getFeaturedModels: getFeaturedModelsMock,
}));

const feedBlock = (feed: Record<string, unknown>) => ({
  id: 1,
  type: HomeBlockType.Feed,
  metadata: { feed },
});

beforeEach(() => {
  getAllImagesIndexMock.mockClear();
  getModelsWithImagesAndModelVersionsMock.mockClear();
});

// An images Feed block is the only way to put "top content made with <base model>" on the
// homepage. The filter reaches Meilisearch on its own once the branch forwards it, so the
// whole feature is this one argument — and dropping it degrades to an unfiltered feed that
// still renders, which is why it needs an assertion rather than a look at the page.
describe('feed baseModels filter', () => {
  it('forwards baseModels to the images feed', async () => {
    await getHomeBlockData({
      input: {},
      homeBlock: feedBlock({ entity: 'images', baseModels: ['MiniMax H3'] }),
    });

    expect(getAllImagesIndexMock).toHaveBeenCalledTimes(1);
    expect(getAllImagesIndexMock.mock.calls[0]?.[0]).toMatchObject({
      baseModels: ['MiniMax H3'],
    });
  });

  // Negative control: the assertion above would also pass if the branch hard-coded a value,
  // or if some default upstream supplied one.
  it('sends no baseModels when the block configures none', async () => {
    await getHomeBlockData({ input: {}, homeBlock: feedBlock({ entity: 'images' }) });

    expect(getAllImagesIndexMock).toHaveBeenCalledTimes(1);
    expect(
      (getAllImagesIndexMock.mock.calls[0]?.[0] as { baseModels?: string[] }).baseModels
    ).toBeUndefined();
  });

  it('still forwards baseModels to the models feed', async () => {
    await getHomeBlockData({
      input: {},
      homeBlock: feedBlock({ entity: 'models', baseModels: ['MiniMax H3'] }),
    });

    expect(getModelsWithImagesAndModelVersionsMock).toHaveBeenCalledTimes(1);
    expect(
      (getModelsWithImagesAndModelVersionsMock.mock.calls[0]?.[0] as { input: unknown }).input
    ).toMatchObject({ baseModels: ['MiniMax H3'] });
  });
});
