import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { NsfwLevel } from '~/server/common/enums';
import type * as FliptClient from '~/server/flipt/client';

/**
 * `images-for-model-version-2` (imagesForModelVersionsCache) behind MODEL_VERSION_IMAGES_L1,
 * through the real cache definition with the cache cluster faked as a store and its entries
 * planted, so the origin query is not involved. Off, no L1 (as before): every read goes to Redis
 * and re-reads each image's tag ids. On, a 30s per-pod L1 holding the value after that tag read.
 *
 * The viewer case runs a real consumer (`getEligibleModels`, which picks a cover with
 * `pickPreviewImage`) for two viewers off ONE cached entry: viewer filtering must happen after the
 * read and never be written into the entry.
 *
 * The cache is one module-level instance for the whole file, so each case uses its own version
 * ids. The L1 clock is `performance.now` (read per call by lru-cache); the Redis fake reads
 * `Date.now`, left alone, so a jump here ages only the L1.
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
const { imagesForModelVersionsCache, deleteImagesForModelVersionCache } = await import(
  '~/server/services/image.service'
);
const { tagIdsForImagesCache } = await import('~/server/redis/caches');
const { resetL1SwitchesForTests } = await import('~/server/redis/l1-switches');
const { getEligibleModels } = await import('~/server/services/eligible-models.service');

const PREFIX = 'packed:caches:images-for-model-version-2:';
let clock = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const advance = async (seconds: number) => {
  clock += seconds * 1000;
  await sleep(5); // lru-cache reuses one clock reading for 1ms
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
// The value a reader gets: the planted entry with each image's tag ids attached.
const withTags = (versionId: number) => {
  const entry = entryFor(versionId);
  return {
    ...entry,
    images: entry.images.map((i) => ({ ...i, tags: tagsFor(i.id) })),
  };
};

let fs: ReturnType<typeof installFakeCacheRedis>;
let flag: boolean | null = null;
let tagReads: MockInstance<(typeof tagIdsForImagesCache)['fetch']>;

const plant = (versionId: number) =>
  fs.plant(`${PREFIX}${versionId}`, { ...entryFor(versionId), cachedAt: new Date() }, 86400);

// lru-cache keeps its last clock reading until a 1ms timer clears it, and a case with no
// `advance` never yields to that timer, so a reading left by the previous case (later than this
// case's restarted clock) would age every entry here. Let it clear before each case.
beforeEach(async () => {
  vi.clearAllMocks();
  fs = installFakeCacheRedis();
  resetL1SwitchesForTests();
  clock = 7_000_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  await sleep(5);
  vi.mocked(isFliptSync).mockImplementation((key: string) =>
    key === 'model-version-images-l1' ? flag : null
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

describe('imagesForModelVersionsCache L1: MODEL_VERSION_IMAGES_L1', () => {
  it('off (flag absent): no L1 — every read goes to Redis and re-reads the tags, as before', async () => {
    flag = null;
    plant(301);
    const first = await imagesForModelVersionsCache.fetch([301]);
    await advance(1);
    const second = await imagesForModelVersionsCache.fetch([301]);

    expect(first).toEqual({ 301: withTags(301) });
    expect(second).toEqual(first);
    expect(redisReads()).toBe(2);
    expect(tagReads).toHaveBeenCalledTimes(2);
    expect(tagReads).toHaveBeenNthCalledWith(2, [3011, 3012]);
  });

  it('on: inside 30s a read makes no Redis call and no tag read; past 30s it reads both again', async () => {
    flag = true;
    plant(402);
    const first = await imagesForModelVersionsCache.fetch([402]);
    expect(first).toEqual({ 402: withTags(402) });
    expect([redisReads(), tagReads.mock.calls.length]).toEqual([1, 1]);

    await advance(15);
    expect(await imagesForModelVersionsCache.fetch([402])).toEqual(first);
    await advance(14); // 29s
    expect(await imagesForModelVersionsCache.fetch([402])).toEqual(first);
    expect([redisReads(), tagReads.mock.calls.length]).toEqual([1, 1]);

    await advance(2); // 31s
    expect(await imagesForModelVersionsCache.fetch([402])).toEqual(first);
    expect([redisReads(), tagReads.mock.calls.length]).toEqual([2, 2]);
    expect(vi.mocked(isFliptSync).mock.calls).toContainEqual(['model-version-images-l1']);
  });

  it("on: a bust still rewrites the Redis entry, and this pod's next read goes to Redis", async () => {
    flag = true;
    plant(503);
    await imagesForModelVersionsCache.fetch([503]);
    await imagesForModelVersionsCache.fetch([503]);
    expect(redisReads()).toBe(1);

    redisMock.redis.packed.set.mockClear();
    await deleteImagesForModelVersionCache(503);
    expect(redisMock.redis.packed.set.mock.calls.map(([key]) => key)).toEqual([`${PREFIX}503`]);

    const readsAfterBust = redisReads();
    await imagesForModelVersionsCache.fetch([503]);
    expect(redisReads()).toBe(readsAfterBust + 1);
  });

  it("on: a consumer editing what it got in place cannot change the next reader's value", async () => {
    flag = true;
    plant(604);
    const first = (await imagesForModelVersionsCache.fetch([604]))[604];
    first.images.splice(0, 1);
    first.images[0].nsfwLevel = NsfwLevel.XXX;
    first.images[0].tags?.push(1);

    const second = (await imagesForModelVersionsCache.fetch([604]))[604];
    expect(redisReads()).toBe(1); // served from the L1
    expect(second).toEqual(withTags(604));
  });
});

describe('viewer filtering stays after the cache read (MODEL_VERSION_IMAGES_L1 on)', () => {
  it('two viewers with different browsing levels get different covers from one cached entry', async () => {
    flag = true;
    plant(705);
    const [rImage, pgImage] = entryFor(705).images;

    const asPg = await getEligibleModels([705], { viewerLevel: NsfwLevel.PG });
    const asR = await getEligibleModels([705], { viewerLevel: NsfwLevel.R });
    const unfiltered = await getEligibleModels([705]);

    // One Redis read for all three: the second and third came from the L1 entry the first filled.
    expect(redisReads()).toBe(1);
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
    expect(await imagesForModelVersionsCache.fetch([705])).toEqual({ 705: withTags(705) });
    expect(redisReads()).toBe(1);
  });

  it('the R viewer reading first does not narrow what the PG viewer gets either', async () => {
    flag = true;
    plant(806);
    const [rImage, pgImage] = entryFor(806).images;

    const asR = await getEligibleModels([806], { viewerLevel: NsfwLevel.R });
    const asPg = await getEligibleModels([806], { viewerLevel: NsfwLevel.PG });

    expect(redisReads()).toBe(1);
    expect(asR.map((m) => m.image?.id)).toEqual([rImage.id]);
    expect(asPg.map((m) => m.image?.id)).toEqual([pgImage.id]);
  });
});
