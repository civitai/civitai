import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeBlockType } from '~/shared/utils/prisma/enums';
import { GET_ALL_IMAGES_PER_MODEL_SLIM } from '~/server/utils/model-getall-images';
import type * as ModelService from '~/server/services/model.service';

const { getModelsWithImagesAndModelVersionsMock, getFeaturedModelsMock } = vi.hoisted(() => ({
  getModelsWithImagesAndModelVersionsMock: vi.fn(async () => ({ items: [] })),
  getFeaturedModelsMock: vi.fn(async () => [{ modelId: 1 }]),
}));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModelsWithImagesAndModelVersions: getModelsWithImagesAndModelVersionsMock,
  getFeaturedModels: getFeaturedModelsMock,
}));

async function loadService() {
  return import('~/server/services/home-block.service');
}

const callArgs = () =>
  getModelsWithImagesAndModelVersionsMock.mock.calls[0]?.[0] as unknown as {
    input: { limit?: number };
    imagesPerModel?: number;
    biasImageSlice?: boolean;
  };

const modelsFeed = (feed: Record<string, unknown>) => ({
  id: 1,
  type: HomeBlockType.Feed,
  metadata: { feed: { entity: 'models', ...feed } },
});

beforeEach(() => {
  getModelsWithImagesAndModelVersionsMock.mockClear();
});

// What the config says is what the block fetches. The number used to be tripled on its way
// through, so a row reading 42 fetched 126 — invisible from the row, and the reason the two
// homepage feeds shipped 3x what anyone had chosen.
describe('feed fetch size', () => {
  it('fetches exactly the configured limit', async () => {
    const { getHomeBlockData } = await loadService();

    await getHomeBlockData({ input: {}, homeBlock: modelsFeed({ limit: 42 }) });

    expect(callArgs().input.limit).toBe(42);
  });

  it('still fetches exactly the configured limit when maxPerUser is set', async () => {
    const { getHomeBlockData } = await loadService();

    await getHomeBlockData({ input: {}, homeBlock: modelsFeed({ limit: 42, maxPerUser: 2 }) });

    expect(callArgs().input.limit).toBe(42);
  });

  // Both feed entities take their size from `resolveFeedFetchLimit`, so the cases below cover
  // the images branch too without mocking `image.service` — which is on the shared-mock
  // migration ratchet, and a new direct mock there moves that count the wrong way.
  it('does not scale the configured limit', async () => {
    const { resolveFeedFetchLimit } = await loadService();

    expect(resolveFeedFetchLimit(42)).toBe(42);
    expect(resolveFeedFetchLimit(7)).toBe(7);
  });

  it('clamps a mistyped limit to the ceiling', async () => {
    const { resolveFeedFetchLimit } = await loadService();

    expect(resolveFeedFetchLimit(5000)).toBe(100);
  });

  // `Math.min(undefined, n)` is NaN, which would reach the fetch unchecked — the metadata is
  // cast, never parsed, so the schema default cannot rescue it.
  it('falls back to the schema default when limit is missing', async () => {
    const { resolveFeedFetchLimit } = await loadService();

    expect(resolveFeedFetchLimit(undefined)).toBe(28);
  });
});

// A cap without `biasImageSlice` drops whole models from a viewer's block rather than
// trimming their images, and it does so silently — no error, no server-side symptom, only a
// shorter block for some viewers. These pin the pair at both call sites.
describe('per-model image cap', () => {
  it('caps and bias-slices the models Feed block', async () => {
    const { getHomeBlockData } = await loadService();

    await getHomeBlockData({ input: {}, homeBlock: modelsFeed({ limit: 42 }) });

    expect(getModelsWithImagesAndModelVersionsMock).toHaveBeenCalledTimes(1);
    expect(callArgs().imagesPerModel).toBe(GET_ALL_IMAGES_PER_MODEL_SLIM);
    expect(callArgs().biasImageSlice).toBe(true);
  });

  it('caps and bias-slices the FeaturedModelVersion block', async () => {
    const { getHomeBlockData } = await loadService();

    await getHomeBlockData({
      input: {},
      homeBlock: { id: 2, type: HomeBlockType.FeaturedModelVersion, metadata: {} },
    });

    expect(getModelsWithImagesAndModelVersionsMock).toHaveBeenCalledTimes(1);
    expect(callArgs().imagesPerModel).toBe(GET_ALL_IMAGES_PER_MODEL_SLIM);
    expect(callArgs().biasImageSlice).toBe(true);
  });
});
