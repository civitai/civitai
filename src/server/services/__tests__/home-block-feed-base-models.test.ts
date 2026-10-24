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

// The "New & Upcoming" shelves (Justin, 2026-10-07, ClickUp 868meb641). Sorted by reactions,
// the 42-item pool went to a few of the board's biggest accounts and the client's per-view cap
// only rotated which two of theirs showed, so these blocks cap followers and each creator's
// share of the POOL. The pool reaches the client at the configured size: #3980 cut a 3x
// multiplier because it shipped 126 items to render 14, and over-fetching here must not undo
// that.
describe('new & upcoming pool caps', () => {
  // Creator 1 holds the top 20 ranked items, as one creator held 14 of 42 on 2026-10-07.
  const rankedPool = () => [
    ...Array.from({ length: 20 }, (_, i) => ({ id: 1000 + i, user: { id: 1 } })),
    ...Array.from({ length: 100 }, (_, i) => ({ id: 2000 + i, user: { id: 10 + i } })),
  ];
  const imagesArg = () =>
    getAllImagesIndexMock.mock.calls[0]?.[0] as unknown as {
      limit: number;
      newCreatorsMaxFollowers?: number;
    };
  const modelsArg = () =>
    getModelsWithImagesAndModelVersionsMock.mock.calls[0]?.[0] as unknown as {
      input: { limit: number };
    };
  const shipped = async (feed: Record<string, unknown>) => {
    const block = await getHomeBlockData({ input: {}, homeBlock: feedBlock(feed) });
    return (block as { feedItems: { items: { id: number; user: { id: number } }[] } }).feedItems
      .items;
  };

  it('caps the images pool at maxPerUser per creator, in rank order, at the configured size', async () => {
    getAllImagesIndexMock.mockResolvedValueOnce({
      items: rankedPool(),
      nextCursor: undefined,
    } as never);

    const items = await shipped({ entity: 'images', newCreators: true, limit: 42, maxPerUser: 2 });

    expect(items).toHaveLength(42);
    expect(items.filter((item) => item.user.id === 1).map((item) => item.id)).toEqual([1000, 1001]);
    expect(items[2]?.id).toBe(2000);
    expect(imagesArg().limit).toBe(126);
  });

  it('caps the models pool the same way', async () => {
    getModelsWithImagesAndModelVersionsMock.mockResolvedValueOnce({ items: rankedPool() } as never);

    const items = await shipped({ entity: 'models', newCreators: true, limit: 42, maxPerUser: 2 });

    expect(items).toHaveLength(42);
    expect(items.filter((item) => item.user.id === 1)).toHaveLength(2);
    expect(modelsArg().input.limit).toBe(126);
  });

  it('asks the images feed for creators under 1,000 followers', async () => {
    await shipped({ entity: 'images', newCreators: true, limit: 42, maxPerUser: 2 });

    expect(imagesArg().newCreatorsMaxFollowers).toBe(1000);
  });

  // The video block (478512) also sets maxPerUser. It is not a new-creators shelf, so its pool,
  // fetch size and creator list must not change.
  it('leaves a non-new-creators block with maxPerUser untouched', async () => {
    getAllImagesIndexMock.mockResolvedValueOnce({
      items: rankedPool(),
      nextCursor: undefined,
    } as never);

    const items = await shipped({ entity: 'images', limit: 42, maxPerUser: 2 });

    expect(imagesArg().limit).toBe(42);
    expect(imagesArg().newCreatorsMaxFollowers).toBeUndefined();
    expect(items.filter((item) => item.user.id === 1)).toHaveLength(20);
  });

  it('does not over-fetch a new-creators block that sets no maxPerUser', async () => {
    await shipped({ entity: 'images', newCreators: true, limit: 42 });

    expect(imagesArg().limit).toBe(42);
  });
});
