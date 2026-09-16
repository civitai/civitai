import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeBlockType } from '~/shared/utils/prisma/enums';
// Module scope for the same reason as home-block-fetch-sizing.test.ts: from a test body this
// graph's transform is charged to one test's 60s budget.
import { getHomeBlockData } from '~/server/services/home-block.service';
import type * as ImageService from '~/server/services/image.service';
import type * as ModelService from '~/server/services/model.service';

const { getAllImagesIndexMock, getModelsWithImagesAndModelVersionsMock } = vi.hoisted(() => ({
  getAllImagesIndexMock: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  getModelsWithImagesAndModelVersionsMock: vi.fn(async () => ({ items: [] })),
}));

// home-block-fetch-sizing.test.ts avoids mocking image.service because the specifier is on the
// shared-mock ratchet. That reasoning does not reach here: asserting the argument requires
// observing the call, and home-block.service imports getAllImagesIndex directly (:24), so the
// graph loads either way — measured at 11s for that file against 12s for this one. The
// specifier is PENDING rather than CANONICAL, which no-direct-shared-module-mock counts and
// deliberately does not assert.
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImagesIndex: getAllImagesIndexMock,
}));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModelsWithImagesAndModelVersions: getModelsWithImagesAndModelVersionsMock,
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

  it('sends no baseModels to the models feed when the block configures none', async () => {
    await getHomeBlockData({ input: {}, homeBlock: feedBlock({ entity: 'models' }) });

    expect(getModelsWithImagesAndModelVersionsMock).toHaveBeenCalledTimes(1);
    expect(
      (
        getModelsWithImagesAndModelVersionsMock.mock.calls[0]?.[0] as {
          input: { baseModels?: string[] };
        }
      ).input.baseModels
    ).toBeUndefined();
  });

  // `[]` reaches both consumers as "match nothing" or "match everything" depending on which
  // guard they use — model.service strips every version off every model and ejects the block.
  // The branch normalizes it to undefined so neither consumer ever sees an empty array.
  it.each([
    ['images', () => getAllImagesIndexMock.mock.calls[0]?.[0] as { baseModels?: string[] }],
    [
      'models',
      () =>
        (
          getModelsWithImagesAndModelVersionsMock.mock.calls[0]?.[0] as {
            input: { baseModels?: string[] };
          }
        ).input,
    ],
  ] as const)(
    'normalizes an empty baseModels to undefined for the %s feed',
    async (entity, arg) => {
      await getHomeBlockData({ input: {}, homeBlock: feedBlock({ entity, baseModels: [] }) });

      expect(arg().baseModels).toBeUndefined();
    }
  );
});
