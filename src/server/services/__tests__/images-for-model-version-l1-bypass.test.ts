import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Prisma } from '@prisma/client';
import type * as FliptClient from '~/server/flipt/client';
import type * as PgDb from '~/server/db/pgDb';
import type * as BlockedBrowsingTags from '~/server/services/blocked-browsing-tags.service';
import type * as PaidAccess from '~/server/services/paid-access.service';
import type * as CreatorProgram from '~/server/services/creator-program.service';
import type * as UserService from '~/server/services/user.service';
import type * as CosmeticService from '~/server/services/cosmetic.service';
import type * as ModelFileService from '~/server/services/model-file.service';
import { letLruClockClear } from '@civitai/redis/__tests__/helpers/lru-clock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { NsfwLevel } from '~/server/common/enums';
// STATIC imports, deliberately: model.service's cold transform would otherwise be charged to one
// test's timeout (see get-models-raw.transient-503.test.ts). vi.mock calls are hoisted above them.
import { isFliptSync } from '~/server/flipt/client';
import {
  getImagesForModelVersionCache,
  imagesForModelVersionsCache,
} from '~/server/services/image.service';
import { getModelsWithVersions } from '~/server/services/model.service';
import {
  getModelSearchIndexRecords,
  pullModelsData,
} from '~/server/search-index/models.search-index';
import { getEcosystemSeoData } from '~/server/services/ecosystem-seo.service';
import {
  dataForModelsCache,
  modelTagCache,
  tagIdsForImagesCache,
  userBasicCache,
} from '~/server/redis/caches';
import { resetL1SwitchesForTests } from '~/server/redis/l1-switches';

/**
 * The `bypassLocal` chain past this process's `images-for-model-version-2` L1, with
 * MODEL_VERSION_IMAGES_L1 on, through the real image.service, model.service, models search index
 * and ecosystem SEO code. Only the bottom is faked: the cache cluster (a store), the database, and
 * services off the images path that getModelsWithVersions also calls (paid access, creator
 * program, user cosmetics, files, blocked tags) plus sibling caches (model data, user basics,
 * model tags, image tag ids).
 *
 * Each case leaves this process's L1 holding an OLD entry while Redis holds a NEWER one (what a
 * refresh on another process leaves behind), checks that a plain read still gets the old one,
 * then reads through the caller under test.
 *
 * The cache is one module-level instance for the whole file, so each case uses its own version.
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
  isFlipt: vi.fn(async () => false),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));

const { cancellableQuery } = vi.hoisted(() => ({ cancellableQuery: vi.fn() }));
vi.mock('~/server/db/pgDb', async (importOriginal) => ({
  ...(await importOriginal<typeof PgDb>()),
  pgDbRead: { cancellableQuery },
}));
vi.mock('~/server/services/blocked-browsing-tags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockedBrowsingTags>()),
  enforceBlockedBrowsingTagsForModels: vi.fn(async () => ({ emptyResult: false })),
}));
vi.mock('~/server/services/paid-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PaidAccess>()),
  getPublicPaidAccessForModelVersions: vi.fn(async () => ({})),
  getModelPaidAccessGates: vi.fn(async () => new Map()),
}));
vi.mock('~/server/services/creator-program.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorProgram>()),
  getValidCreatorMembershipMap: vi.fn(async () => new Map()),
  getUserMetricPrivacyDefaultsMap: vi.fn(async () => new Map()),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getCosmeticsForUsers: vi.fn(async () => ({})),
  getProfilePicturesForUsers: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/cosmetic.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticService>()),
  getCosmeticsForEntity: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/model-file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelFileService>()),
  getFilesForModelVersionCache: vi.fn(async () => ({})),
}));

const PREFIX = 'packed:caches:images-for-model-version-2:';
const MODEL_ID = 61;
const USER_ID = 62;

// One image per entry. The old and new entries differ in image id and url, so a caller that got
// the wrong one cannot pass.
type Generation = 'old' | 'new';
const imageId = (versionId: number, gen: Generation) => versionId * 10 + (gen === 'old' ? 1 : 2);
const urlFor = (versionId: number, gen: Generation) => `url-${versionId}-${gen}`;
const entryFor = (versionId: number, gen: Generation) => ({
  modelVersionId: versionId,
  images: [
    {
      id: imageId(versionId, gen),
      modelVersionId: versionId,
      userId: USER_ID,
      name: `img-${versionId}-${gen}`,
      url: urlFor(versionId, gen),
      nsfwLevel: NsfwLevel.PG,
      width: 512,
      height: 768,
      hash: `hash-${versionId}-${gen}`,
      type: 'image',
      metadata: {},
    },
  ],
});

let fs: ReturnType<typeof installFakeCacheRedis>;
let tagReads: MockInstance<(typeof tagIdsForImagesCache)['fetch']>;
const plant = (versionId: number, gen: Generation) =>
  fs.plant(`${PREFIX}${versionId}`, { ...entryFor(versionId, gen), cachedAt: new Date() }, 86400);

const urlsOf = (entry: { images: { url: string }[] } | undefined) =>
  entry?.images.map((i) => i.url);

/**
 * Leave this process's L1 holding the old entry for `versionId` and Redis the new one, and check a
 * plain read still gets the old one (the precondition every case below depends on).
 */
async function oldInL1NewInRedis(versionId: number) {
  plant(versionId, 'old');
  expect(urlsOf((await getImagesForModelVersionCache([versionId]))[versionId])).toEqual([
    urlFor(versionId, 'old'),
  ]);
  plant(versionId, 'new');
  expect(urlsOf((await imagesForModelVersionsCache.fetch([versionId]))[versionId])).toEqual([
    urlFor(versionId, 'old'),
  ]);
}

/** One published model with one version, as getModelsRaw reads it. */
function primeOneModel(versionId: number) {
  cancellableQuery.mockResolvedValue({
    result: async () => [
      {
        id: MODEL_ID,
        userId: USER_ID,
        name: 'model',
        cursorId: null,
        meta: null,
        rank: {
          downloadCount: 0,
          thumbsUpCount: 0,
          thumbsDownCount: 0,
          commentCount: 0,
          collectedCount: 0,
          tippedAmountCount: 0,
        },
      },
    ],
  });
  vi.spyOn(dataForModelsCache, 'fetch').mockResolvedValue({
    [MODEL_ID]: {
      hashes: [],
      tags: [],
      versions: [
        {
          id: versionId,
          name: 'v1',
          status: 'Published',
          baseModel: 'SD 1.5',
          nsfwLevel: 1,
          availability: 'Public',
          covered: true,
          trainingStatus: null,
          earlyAccessTimeFrame: 0,
        },
      ],
    },
  } as never);
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([{ id: versionId, meta: null }] as never);
}

const callGetModelsWithVersions = (bypassImagesL1?: boolean) =>
  getModelsWithVersions({
    input: { browsingLevel: 1, take: 10, period: 'AllTime' } as never,
    user: { id: USER_ID, isModerator: true },
    bypassImagesL1,
  });

beforeEach(async () => {
  vi.clearAllMocks();
  fs = installFakeCacheRedis();
  resetL1SwitchesForTests();
  vi.spyOn(performance, 'now').mockImplementation(() => 3_000_000);
  await letLruClockClear();
  vi.mocked(isFliptSync).mockImplementation((key: string) =>
    key === 'model-version-images-l1' ? true : null
  );
  tagReads = vi
    .spyOn(tagIdsForImagesCache, 'fetch')
    .mockImplementation(async (ids: number | number[]) =>
      Object.fromEntries([ids].flat().map((id) => [id, { imageId: id, tags: [id * 100 + 7] }]))
    );
  vi.spyOn(userBasicCache, 'fetch').mockResolvedValue({});
  vi.spyOn(modelTagCache, 'fetch').mockResolvedValue({});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('images-for-model-version-2 L1 bypass (MODEL_VERSION_IMAGES_L1 on)', () => {
  it('getImagesForModelVersionCache: without bypassLocal the L1 copy, with it the Redis value', async () => {
    await oldInL1NewInRedis(9101);

    const plain = await getImagesForModelVersionCache([9101]);
    const bypassed = await getImagesForModelVersionCache([9101], { bypassLocal: true });

    expect(urlsOf(plain[9101])).toEqual([urlFor(9101, 'old')]);
    expect(urlsOf(bypassed[9101])).toEqual([urlFor(9101, 'new')]);
    expect(tagReads).toHaveBeenCalled();
  });

  it('getModelsWithVersions: without bypassImagesL1 the L1 copy, with it the Redis value', async () => {
    await oldInL1NewInRedis(9202);
    primeOneModel(9202);

    const plain = await callGetModelsWithVersions();
    expect(plain.items).toHaveLength(1);
    expect(plain.items[0].modelVersions[0].images.map((i) => [i.id, i.url])).toEqual([
      [imageId(9202, 'old'), urlFor(9202, 'old')],
    ]);

    const bypassed = await callGetModelsWithVersions(true);
    expect(bypassed.items[0].modelVersions[0].images.map((i) => [i.id, i.url])).toEqual([
      [imageId(9202, 'new'), urlFor(9202, 'new')],
    ]);
  });

  it('models search index pullModelsData: builds the documents from the Redis value', async () => {
    await oldInL1NewInRedis(9303);
    const db = {
      model: { findMany: vi.fn(async () => [{ id: MODEL_ID, modelVersions: [{ id: 9303 }] }]) },
    };

    const result = await pullModelsData(
      { db, logger: () => undefined } as never,
      {
        type: 'update',
        ids: [MODEL_ID],
      } as never
    );

    expect(result.images.map((i) => i.url)).toEqual([urlFor(9303, 'new')]);
  });

  it('models search index getModelSearchIndexRecords: reads the cache with bypassLocal', async () => {
    // A call-argument check rather than a full read: what follows the read (transformData) pulls
    // category tags, paid-access terms and resource insights, none of which bear on the L1.
    dbMock.dbRead.model.findMany.mockResolvedValueOnce([
      { id: MODEL_ID, modelVersions: [{ id: 9404 }] },
    ] as never);
    const stop = new Error('stop after the images read');
    const fetch = vi.spyOn(imagesForModelVersionsCache, 'fetch').mockRejectedValueOnce(stop);

    await expect(getModelSearchIndexRecords([MODEL_ID])).rejects.toBe(stop);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith([9404], { bypassLocal: true });
  });

  it('ecosystem SEO getTopLoras: the stored LoRA cover comes from the Redis value', async () => {
    await oldInL1NewInRedis(9505);
    dbMock.dbRead.$queryRaw.mockImplementation((async (query: Prisma.Sql) =>
      query.sql.includes('eco_loras')
        ? [
            {
              model_id: MODEL_ID,
              version_id: 9505,
              name: 'lora',
              download_count: 5,
              generation_count: 3,
            },
          ]
        : []) as never);

    const data = await getEcosystemSeoData('SDXL', { refresh: true });

    expect(data?.topLoras.map((l) => [l.versionId, l.imageUrl])).toEqual([
      [9505, urlFor(9505, 'new')],
    ]);
  });
});
