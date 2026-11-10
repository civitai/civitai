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
import { pullModelsData } from '~/server/search-index/models.search-index';
import { getEcosystemSeoData } from '~/server/services/ecosystem-seo.service';
import { getEligibleModels } from '~/server/services/eligible-models.service';
import {
  dataForModelsCache,
  modelTagCache,
  tagIdsForImagesCache,
  userBasicCache,
} from '~/server/redis/caches';
import { resetL1SwitchesForTests } from '~/server/redis/l1-switches';

/**
 * Public readers of `images-for-model-version-2` read past this process's L1, with
 * MODEL_VERSION_IMAGES_L1 on, through the real image.service, model.service, eligible-models,
 * models search index and ecosystem SEO code. Only the bottom is faked: the cache cluster (a store),
 * the database, and services off the images path that getModelsWithVersions also calls (paid
 * access, creator program, user cosmetics, files, blocked tags) plus sibling caches (model data,
 * user basics, model tags, image tag ids).
 *
 * Each case leaves this process's L1 holding an entry with an image that has since been removed
 * (moderation block, delete, unpublish) while Redis holds the refreshed entry without it: what a
 * refresh on another process leaves behind. It checks that an `allowLocal` read still gets the
 * removed image, then reads through the public caller under test.
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

// Before the removal the entry holds a kept and a removed image; after it, only the kept one. Ids,
// urls and hashes are pairwise distinct, so a caller served the stale entry cannot pass.
type Generation = 'stale' | 'current';
const keptId = (versionId: number) => versionId * 10 + 1;
const removedId = (versionId: number) => versionId * 10 + 2;
const image = (versionId: number, id: number) => ({
  id,
  modelVersionId: versionId,
  userId: USER_ID,
  name: `img-${id}`,
  url: `url-${id}`,
  nsfwLevel: NsfwLevel.PG,
  width: 512,
  height: 768,
  hash: `hash-${id}`,
  type: 'image',
  metadata: {},
});
const entryFor = (versionId: number, gen: Generation) => ({
  modelVersionId: versionId,
  images:
    gen === 'stale'
      ? [image(versionId, removedId(versionId)), image(versionId, keptId(versionId))]
      : [image(versionId, keptId(versionId))],
});

let fs: ReturnType<typeof installFakeCacheRedis>;
let tagReads: MockInstance<(typeof tagIdsForImagesCache)['fetch']>;
const plant = (versionId: number, gen: Generation) =>
  fs.plant(`${PREFIX}${versionId}`, { ...entryFor(versionId, gen), cachedAt: new Date() }, 86400);

const idsOf = (entry: { images: { id: number }[] } | undefined) => entry?.images.map((i) => i.id);

/**
 * Leave this process's L1 holding the entry with the removed image and Redis the refreshed one,
 * and check an L1 reader still gets the removed image (the precondition every case depends on).
 */
async function removedInL1Only(versionId: number) {
  plant(versionId, 'stale');
  const l1Read = async () =>
    idsOf((await imagesForModelVersionsCache.fetch([versionId], { allowLocal: true }))[versionId]);
  expect(await l1Read()).toEqual([removedId(versionId), keptId(versionId)]);
  plant(versionId, 'current');
  expect(await l1Read()).toEqual([removedId(versionId), keptId(versionId)]);
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

const callGetModelsWithVersions = () =>
  getModelsWithVersions({
    input: { browsingLevel: 1, take: 10, period: 'AllTime' } as never,
    user: { id: USER_ID, isModerator: true },
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

describe('images-for-model-version-2 public readers skip the L1 (MODEL_VERSION_IMAGES_L1 on)', () => {
  it('getImagesForModelVersionCache (image.getImagesForModelVersion, model feed, covers)', async () => {
    await removedInL1Only(9101);

    const result = await getImagesForModelVersionCache([9101]);

    expect(idsOf(result[9101])).toEqual([keptId(9101)]);
    expect(tagReads).toHaveBeenCalled();
  });

  it('getModelsWithVersions (model search, /api/v1/models)', async () => {
    await removedInL1Only(9202);
    primeOneModel(9202);

    const { items } = await callGetModelsWithVersions();

    expect(items).toHaveLength(1);
    expect(items[0].modelVersions[0].images.map((i) => [i.id, i.url])).toEqual([
      [keptId(9202), `url-${keptId(9202)}`],
    ]);
  });

  it('imagesForModelVersionsCache.fetch with no options (downloads, auctions, generation)', async () => {
    await removedInL1Only(9606);

    const result = await imagesForModelVersionsCache.fetch([9606]);

    expect(idsOf(result[9606])).toEqual([keptId(9606)]);
  });

  it('getEligibleModels (challenge models)', async () => {
    await removedInL1Only(9707);
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([
      { id: 9707, name: 'v1', baseModel: 'SDXL 1.0', model: { id: MODEL_ID, name: 'model' } },
    ] as never);

    const models = await getEligibleModels([9707]);

    expect(models.map((m) => m.image?.id)).toEqual([keptId(9707)]);
  });

  it('models search index pullModelsData: builds the documents from the Redis value', async () => {
    await removedInL1Only(9303);
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

    expect(result.images.map((i) => i.id)).toEqual([keptId(9303)]);
  });

  it('ecosystem SEO getTopLoras: the stored LoRA cover comes from the Redis value', async () => {
    await removedInL1Only(9505);
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
      [9505, `url-${keptId(9505)}`],
    ]);
  });
});
