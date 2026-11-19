import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { HomeBlockType } from '~/shared/utils/prisma/enums';
// Module scope, as in home-block-fetch-sizing.test.ts: this graph's transform must not be charged
// to one test's budget.
import { getHomeBlockData } from '~/server/services/home-block.service';
import {
  bustFeaturedModelsHomeBlockCache,
  getHomeBlockCached,
} from '~/server/services/home-block-cache.service';
import type { SessionUser } from '~/types/session';
import { REDIS_KEYS } from '~/server/redis/client';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ModelService from '~/server/services/model.service';

type Img = { id: number; nsfwLevel: number };
type FakeModel = {
  id: number;
  nsfw: boolean;
  poi: boolean;
  nsfwLevel: number;
  user: { id: number; image: string | null; profilePicture: Img | null };
  images: Img[];
};

const { getModelsWithImagesAndModelVersionsMock, getFeaturedModelsMock, state } = vi.hoisted(() => {
  const state = { items: [] as unknown[] };
  return {
    state,
    getModelsWithImagesAndModelVersionsMock: vi.fn(async () => ({ items: state.items })),
    getFeaturedModelsMock: vi.fn(async () => [
      { modelId: 1, position: 1 },
      { modelId: 2, position: 2 },
      { modelId: 3, position: 3 },
    ]),
  };
});

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModelsWithImagesAndModelVersions: getModelsWithImagesAndModelVersionsMock,
  getFeaturedModels: getFeaturedModelsMock,
}));

const PG = NsfwLevel.PG;
const PG13 = NsfwLevel.PG13;

const model = (id: number, images: Img[], avatar: Img | null = null): FakeModel => ({
  id,
  nsfw: false,
  poi: false,
  nsfwLevel: images.reduce((acc, i) => acc | i.nsfwLevel, 0),
  user: { id: 100 + id, image: `https://example.test/${id}.png`, profilePicture: avatar },
  images,
});

const featuredBlock = { id: 2, type: HomeBlockType.FeaturedModelVersion, metadata: {} };
const modelsFeedBlock = {
  id: 1,
  type: HomeBlockType.Feed,
  metadata: { feed: { entity: 'models', limit: 42 } },
};

async function featured(user?: SessionUser) {
  const block = await getHomeBlockData({ input: { limit: 56 }, homeBlock: featuredBlock, user });
  return (block as { featuredModels: FakeModel[] }).featuredModels;
}

beforeEach(() => {
  getModelsWithImagesAndModelVersionsMock.mockClear();
  redisMock.redis.packed.get.mockReset();
  redisMock.redis.packed.get.mockImplementation(async () => null);
  redisMock.redis.del.mockClear();
});

describe('Featured Models home block shows PG only', () => {
  it('keeps a model whose PG-13 cover has a PG image to fall back to, with only its PG images', async () => {
    state.items = [
      model(1, [
        { id: 11, nsfwLevel: PG13 },
        { id: 12, nsfwLevel: PG },
        { id: 13, nsfwLevel: PG13 },
      ]),
    ];

    const [only] = await featured();

    expect(only.id).toBe(1);
    expect(only.images.map((i) => i.id)).toEqual([12]);
  });

  it('drops a model that has no PG image', async () => {
    state.items = [
      model(1, [{ id: 11, nsfwLevel: PG }]),
      model(2, [
        { id: 21, nsfwLevel: PG13 },
        { id: 22, nsfwLevel: PG13 },
      ]),
    ];

    expect((await featured()).map((m) => m.id)).toEqual([1]);
  });

  // The model's level covers every image it has; the payload carries only the cached slice.
  it('drops a model with a PG bit whose payload holds no PG image', async () => {
    state.items = [{ ...model(2, [{ id: 21, nsfwLevel: PG13 }]), nsfwLevel: PG | PG13 }];

    expect(await featured()).toEqual([]);
  });

  it('drops a model whose level carries no PG bit even if an image claims PG', async () => {
    state.items = [{ ...model(3, [{ id: 31, nsfwLevel: PG }]), nsfwLevel: PG13 }];

    expect(await featured()).toEqual([]);
  });

  it('drops images with an unrated level', async () => {
    state.items = [
      model(1, [
        { id: 11, nsfwLevel: 0 },
        { id: 12, nsfwLevel: PG },
      ]),
    ];

    const [only] = await featured();

    expect(only.images.map((i) => i.id)).toEqual([12]);
  });

  it('strips a creator avatar that is not PG, and keeps a PG one', async () => {
    state.items = [
      model(1, [{ id: 11, nsfwLevel: PG }], { id: 91, nsfwLevel: PG13 }),
      model(2, [{ id: 21, nsfwLevel: PG }], { id: 92, nsfwLevel: PG }),
    ];

    const [first, second] = await featured();

    expect(first.user.profilePicture).toBeNull();
    expect(first.user.image).toBeNull();
    expect(second.user.profilePicture?.id).toBe(92);
  });

  // The admin picker reads this block with the viewer attached; the cap is not the viewer's.
  it('caps a signed-in viewer who allows PG-13 the same way', async () => {
    state.items = [
      model(1, [
        { id: 11, nsfwLevel: PG13 },
        { id: 12, nsfwLevel: PG },
      ]),
    ];
    const viewer = { id: 7, showNsfw: true, browsingLevel: PG | PG13 } as unknown as SessionUser;

    const [only] = await featured(viewer);

    expect(only.images.map((i) => i.id)).toEqual([12]);
  });

  it('does not mutate the arrays the model service handed back', async () => {
    const images = [
      { id: 11, nsfwLevel: PG13 },
      { id: 12, nsfwLevel: PG },
    ];
    const avatar = { id: 91, nsfwLevel: PG13 };
    const source = model(1, images, avatar);
    state.items = [source];

    await featured();

    expect(source.images).toBe(images);
    expect(images.map((i) => i.id)).toEqual([11, 12]);
    expect(source.user.profilePicture).toBe(avatar);
  });

  // Positive control: the cap is this block's, not the homepage's.
  it('leaves PG-13 in a models Feed block', async () => {
    const pg13 = model(2, [{ id: 21, nsfwLevel: PG13 }]);
    state.items = [pg13];

    const block = await getHomeBlockData({ input: {}, homeBlock: modelsFeedBlock });
    const items = (block as { feedItems?: { items: FakeModel[] } }).feedItems?.items ?? [];

    expect(items.map((m) => m.images.map((i) => i.nsfwLevel))).toContainEqual([PG13]);
  });

  // Entries written before the cap carried PG-13 and live up to an hour; none may be read again.
  it('does not serve a Redis entry written under the pre-cap key', async () => {
    const stale = { featuredModels: [model(9, [{ id: 99, nsfwLevel: PG13 }])] };
    redisMock.redis.packed.get.mockImplementation(async (key: string) =>
      key.startsWith(`${REDIS_KEYS.HOMEBLOCKS.BASE}:${HomeBlockType.FeaturedModelVersion}:default`)
        ? stale
        : null
    );
    state.items = [model(1, [{ id: 11, nsfwLevel: PG }])];

    const block = await getHomeBlockCached(featuredBlock, undefined, {});

    expect((block as { featuredModels: FakeModel[] }).featuredModels.map((m) => m.id)).toEqual([1]);
  });

  // A won auction must clear the entry the block actually reads, or it serves the old winners.
  it('busts the entry the block is cached under', async () => {
    state.items = [model(1, [{ id: 11, nsfwLevel: PG }])];
    await getHomeBlockCached(featuredBlock, undefined, {});
    const readKey = redisMock.redis.packed.get.mock.calls[0][0];

    await bustFeaturedModelsHomeBlockCache();

    expect(redisMock.redis.del.mock.calls.map(([key]) => key)).toContain(readKey);
  });
});
