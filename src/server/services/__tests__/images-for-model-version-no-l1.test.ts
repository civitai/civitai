import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { letLruClockClear } from '@civitai/redis/__tests__/helpers/lru-clock';
import { NsfwLevel } from '~/server/common/enums';
import type * as FliptClient from '~/server/flipt/client';

/**
 * `images-for-model-version-2` (imagesForModelVersionsCache) has NO per-process (L1) layer. Its
 * value feeds public readers after moderation filtering (imageBlockedForConditions), and a refresh
 * or bust reaches Redis but no other process's memory, so an L1 would keep serving images that a
 * refresh already removed. Every read therefore goes to Redis.
 *
 * Runs through the real cache definition with the cache cluster faked as a store and its entries
 * planted, so the origin query is not involved. Every L1 switch flag reads as ON (including the
 * removed `model-version-images-l1` key), so a local layer re-added behind any switch, or
 * unconditionally, serves the old entry and fails here.
 *
 * The viewer cases run a real consumer (`getEligibleModels`, which picks a cover with
 * `pickPreviewImage`) for two viewers off ONE cached entry: viewer filtering must happen after the
 * read and never be written into the entry.
 *
 * The cache is one module-level instance for the whole file, so each case uses its own version
 * ids. The L1 clock is a mocked `performance.now` (see letLruClockClear); the Redis fake reads
 * `Date.now`, left alone, so a jump here ages only an L1, never the Redis entry.
 */

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: vi.fn(),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));

const { isFliptSync } = await import('~/server/flipt/client');
const { imagesForModelVersionsCache } = await import('~/server/services/image.service');
const { tagIdsForImagesCache } = await import('~/server/redis/caches');
const { resetL1SwitchesForTests } = await import('~/server/redis/l1-switches');
const { getEligibleModels } = await import('~/server/services/eligible-models.service');

const PREFIX = 'packed:caches:images-for-model-version-2:';
let clock = 0;
const advance = async (seconds: number) => {
  clock += seconds * 1000;
  await letLruClockClear();
};
const redisReads = () =>
  redisMock.redis.packed.mGet.mock.calls.filter(([keys]) =>
    (keys as string[]).some((k) => k.startsWith(PREFIX))
  ).length;

// Pairwise-distinct ids, urls, levels and tag ids, none equal to another's, so an image served in
// the wrong place or with the wrong level cannot pass. The R image comes FIRST: a PG viewer must
// skip it, an R viewer must take it.
const image = (id: number, versionId: number, nsfwLevel: number) => ({
  id,
  modelVersionId: versionId,
  userId: id + 500,
  name: `img-${id}`,
  url: `url-${id}`,
  nsfwLevel,
  width: 512 + id,
  height: 768 + id,
  hash: `hash-${id}`,
  type: 'image',
  metadata: { size: id },
});
const entryFor = (versionId: number) => ({
  modelVersionId: versionId,
  images: [
    image(versionId * 10 + 1, versionId, NsfwLevel.R),
    image(versionId * 10 + 2, versionId, NsfwLevel.PG),
  ],
});
const tagsFor = (imageId: number) => [imageId * 100 + 7, imageId * 100 + 9];
const withTags = (entry: ReturnType<typeof entryFor>) => ({
  ...entry,
  images: entry.images.map((i) => ({ ...i, tags: tagsFor(i.id) })),
});

let fs: ReturnType<typeof installFakeCacheRedis>;
let tagReads: MockInstance<(typeof tagIdsForImagesCache)['fetch']>;

const plant = (entry: ReturnType<typeof entryFor>) =>
  fs.plant(`${PREFIX}${entry.modelVersionId}`, { ...entry, cachedAt: new Date() }, 86400);

beforeEach(async () => {
  vi.clearAllMocks();
  fs = installFakeCacheRedis();
  resetL1SwitchesForTests();
  clock = 7_000_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  await letLruClockClear();
  // Every L1 switch on, by key shape, so a renamed images switch is covered too.
  vi.mocked(isFliptSync).mockImplementation((key: string) =>
    key === 'model-version-images-l1' || /(^|-)l1(-|$)/.test(key) ? true : null
  );
  tagReads = vi
    .spyOn(tagIdsForImagesCache, 'fetch')
    .mockImplementation(async (ids: number | number[]) =>
      Object.fromEntries(
        [ids].flat().map((imageId) => [imageId, { imageId, tags: tagsFor(imageId) }])
      )
    );
  dbMock.dbRead.modelVersion.findMany.mockImplementation((async (args: {
    where: { id: { in: number[] } };
  }) =>
    args.where.id.in.map((id) => ({
      id,
      name: `version-${id}`,
      baseModel: 'SDXL 1.0',
      model: { id: id + 9000, name: `model-${id}` },
    }))) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('imagesForModelVersionsCache has no per-process L1', () => {
  it('a Redis refresh is what the next read in this process returns, one second later', async () => {
    const before = entryFor(301);
    plant(before);
    expect(await imagesForModelVersionsCache.fetch([301])).toEqual({ 301: withTags(before) });

    // What a refresh after moderation leaves in Redis: the R image is gone, the PG one re-rated.
    const after = {
      modelVersionId: 301,
      images: [{ ...before.images[1], nsfwLevel: NsfwLevel.PG13 }],
    };
    plant(after);
    await advance(1);

    expect(await imagesForModelVersionsCache.fetch([301])).toEqual({ 301: withTags(after) });
    expect(redisReads()).toBe(2);
    expect(tagReads).toHaveBeenCalledTimes(2);
    expect(tagReads).toHaveBeenNthCalledWith(2, [before.images[1].id], { bypassLocal: false });
  });

  it('every read goes to Redis and re-reads the tag ids, however close together', async () => {
    const entry = entryFor(402);
    plant(entry);
    for (let i = 0; i < 3; i++) {
      expect(await imagesForModelVersionsCache.fetch([402])).toEqual({ 402: withTags(entry) });
      await advance(5);
    }
    expect([redisReads(), tagReads.mock.calls.length]).toEqual([3, 3]);
  });

  // The models search index fetches with bypassLocal; the tag ids it writes into a document come
  // from this appendFn read, so the flag has to reach it.
  it("passes the caller's bypassLocal on to the tag-id read", async () => {
    const entry = entryFor(503);
    plant(entry);
    await imagesForModelVersionsCache.fetch([503], { bypassLocal: true });
    expect(tagReads).toHaveBeenCalledTimes(1);
    expect(tagReads).toHaveBeenCalledWith(
      entry.images.map((i) => i.id),
      { bypassLocal: true }
    );
  });
});

describe('viewer filtering stays after the cache read', () => {
  it('two viewers with different browsing levels get different covers from one cached entry', async () => {
    const entry = entryFor(705);
    plant(entry);
    const [rImage, pgImage] = entry.images;

    const asPg = await getEligibleModels([705], { viewerLevel: NsfwLevel.PG });
    const asR = await getEligibleModels([705], { viewerLevel: NsfwLevel.R });
    const unfiltered = await getEligibleModels([705]);

    expect(asPg.map((m) => m.image?.id)).toEqual([pgImage.id]);
    expect(asR.map((m) => m.image?.id)).toEqual([rImage.id]);
    expect(unfiltered.map((m) => m.image?.id)).toEqual([rImage.id]);
    expect(asPg[0].image).toEqual({
      id: pgImage.id,
      url: pgImage.url,
      nsfwLevel: NsfwLevel.PG,
      hash: pgImage.hash,
      width: pgImage.width,
      height: pgImage.height,
      type: pgImage.type,
    });
    // The entry itself still holds every image, unfiltered.
    expect(await imagesForModelVersionsCache.fetch([705])).toEqual({ 705: withTags(entry) });
  });

  it('the R viewer reading first does not narrow what the PG viewer gets either', async () => {
    const entry = entryFor(806);
    plant(entry);
    const [rImage, pgImage] = entry.images;

    const asR = await getEligibleModels([806], { viewerLevel: NsfwLevel.R });
    const asPg = await getEligibleModels([806], { viewerLevel: NsfwLevel.PG });

    expect(asR.map((m) => m.image?.id)).toEqual([rImage.id]);
    expect(asPg.map((m) => m.image?.id)).toEqual([pgImage.id]);
  });
});
