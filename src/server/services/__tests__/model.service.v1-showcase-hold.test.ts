import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import { NsfwLevel } from '~/server/common/enums';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * The public model API (`/api/v1/models`, `/api/v1/models/[id]`) and the model-version API
 * (`/api/v1/model-versions/[id]` and by-hash) serve a minor or SFW-only model's showcase at the
 * model's gallery level. Drives the REAL `getModelsWithVersions` and `holdShowcaseImages`; only
 * I/O is stubbed, with the scaffold from model.service.vae-append-no-mutation.test.ts (whose
 * header says why each module is stubbed).
 */

const VERSION_ID = 42;
const MODEL_ID = 7;
const USER_ID = 5;

const { mockGetFilesForModelVersionCache, mockCancellableQuery, mockImagesCache } = vi.hoisted(
  () => ({
    mockGetFilesForModelVersionCache: vi.fn(),
    mockCancellableQuery: vi.fn(),
    mockImagesCache: vi.fn(),
  })
);

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: { cancellableQuery: mockCancellableQuery },
  pgDbWrite: {},
  pgDbReadLong: {},
}));

vi.mock('~/server/services/model-file.service', () => ({
  getFilesForModelVersionCache: mockGetFilesForModelVersionCache,
  deleteFilesForModelVersionCache: vi.fn(),
}));

vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: mockImagesCache,
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn().mockResolvedValue(false),
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
  getShowcaseImageFilter: vi.fn(async () => () => true),
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(),
  getPublicPaidAccessForModelVersions: vi.fn().mockResolvedValue({}),
  getModelPaidAccessGates: vi.fn().mockResolvedValue(new Map()),
  bustPaidAccessCache: vi.fn(),
  bustModelSaleCache: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  getValidCreatorMembershipMap: vi.fn().mockResolvedValue(new Map()),
  getUserMetricPrivacyDefaultsMap: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('~/server/services/user.service', () => ({
  deleteBasicDataForUser: vi.fn(),
  getCosmeticsForUsers: vi.fn().mockResolvedValue({}),
  getProfilePicturesForUsers: vi.fn().mockResolvedValue({}),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: vi.fn() }));
vi.mock('~/server/services/creator-gallery-hidden-users.service', () => ({
  bustModelGallerySettings: vi.fn(),
  getCreatorGalleryHiddenUserIds: vi.fn(async () => []),
}));
// This list must track model.service's own import list from this module. A missing name is not a
// test failure — vitest throws it during module evaluation, so the file collects ZERO tests and the
// run stays green with this guard silently absent.
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { fetch: vi.fn() },
  modelVersionPublicDonationGoalsCache: { fetch: vi.fn(), bust: vi.fn() },
  modelTagCache: { fetch: vi.fn(), bust: vi.fn() },
  modelVotableTagsCache: { fetch: vi.fn(), bust: vi.fn() },
  userBasicCache: { fetch: vi.fn().mockResolvedValue({}), bust: vi.fn() },
  userModelCountCache: { fetch: vi.fn(), bust: vi.fn() },
}));

import { getModelsWithVersions, holdShowcaseImages } from '~/server/services/model.service';
import { dataForModelsCache } from '~/server/redis/caches';

const image = (id: number, nsfwLevel: number) => ({
  id,
  nsfwLevel,
  url: `u${id}`,
  modelVersionId: VERSION_ID,
  name: null,
  userId: USER_ID,
});
const SHOWCASE = [
  image(1, NsfwLevel.PG),
  image(2, NsfwLevel.PG13),
  image(3, NsfwLevel.R),
  image(4, NsfwLevel.X),
];
const SFW_IDS = [1, 2];
const ALL_IDS = [1, 2, 3, 4];

/** The model row as `getGallerySettingsByModelId` reads it on a settings-cache miss. */
function storedModel(row: { minor?: boolean; sfwOnly?: boolean; gallerySettings: unknown }) {
  for (const db of [dbMock.dbRead, dbMock.dbWrite])
    db.model.findFirst.mockResolvedValue({
      id: MODEL_ID,
      userId: USER_ID,
      minor: false,
      sfwOnly: false,
      ...row,
    } as never);
}

function primeOneModel(flags: { minor: boolean; sfwOnly: boolean }) {
  mockCancellableQuery.mockResolvedValue({
    result: async () => [
      {
        id: MODEL_ID,
        userId: USER_ID,
        name: 'M',
        cursorId: null,
        meta: null,
        ...flags,
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
  vi.mocked(dataForModelsCache.fetch).mockResolvedValue({
    [MODEL_ID]: {
      hashes: [],
      tags: [],
      versions: [
        {
          id: VERSION_ID,
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
  dbMock.dbRead.$queryRaw.mockResolvedValue([]);
  dbMock.dbRead.modelMetric.findMany.mockResolvedValue([]);
  dbMock.dbRead.modelVersionMetric.findMany.mockResolvedValue([]);
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([{ id: VERSION_ID, meta: null }]);
  dbMock.dbRead.recommendedResource.findMany.mockResolvedValue([]);
  dbMock.dbRead.modelFile.findMany.mockResolvedValue([]);
  mockGetFilesForModelVersionCache.mockResolvedValue({
    [VERSION_ID]: {
      modelVersionId: VERSION_ID,
      files: [
        {
          id: 1,
          name: 'a.safetensors',
          type: 'Model',
          modelVersionId: VERSION_ID,
          metadata: {},
          hashes: [],
        },
      ],
    },
  });
  mockImagesCache.mockResolvedValue({
    [VERSION_ID]: { modelVersionId: VERSION_ID, images: SHOWCASE },
  });
}

async function servedByModelsApi() {
  const { items } = await getModelsWithVersions({
    input: { browsingLevel: 1, take: 10, period: 'AllTime' } as never,
  });
  expect(items).toHaveLength(1);
  return items[0].modelVersions[0].images.map((i: { id: number }) => i.id);
}

/** The version API's call: one version, its model id only, no flags. */
async function servedByVersionApi() {
  const held = await holdShowcaseImages(
    { [VERSION_ID]: { images: SHOWCASE } },
    new Map([[VERSION_ID, { modelId: MODEL_ID }]])
  );
  return held[VERSION_ID].images.map((i) => i.id);
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.redis.get.mockResolvedValue(null);
});

describe('/api/v1/models — a minor or SFW-only model', () => {
  it('serves a minor model with stored gallery level 0 only within SFW', async () => {
    primeOneModel({ minor: true, sfwOnly: false });
    storedModel({ minor: true, gallerySettings: { level: 0 } });
    expect(await servedByModelsApi()).toEqual(SFW_IDS);
  });

  it('serves an SFW-only model within SFW', async () => {
    primeOneModel({ minor: false, sfwOnly: true });
    storedModel({ sfwOnly: true, gallerySettings: { level: 31 } });
    expect(await servedByModelsApi()).toEqual(SFW_IDS);
  });

  it('serves an unflagged model whole, without reading its gallery settings', async () => {
    primeOneModel({ minor: false, sfwOnly: false });
    storedModel({ gallerySettings: { level: 1 } });
    expect(await servedByModelsApi()).toEqual(ALL_IDS);
    expect(dbMock.dbRead.model.findFirst).not.toHaveBeenCalled();
  });

  it('holds a flagged row whose cached settings predate the flag', async () => {
    primeOneModel({ minor: true, sfwOnly: false });
    redisMock.redis.get.mockResolvedValue(
      JSON.stringify({
        hiddenTags: [],
        hiddenUsers: [],
        hiddenImages: {},
        pinnedPosts: {},
        level: 31,
        sfwHeld: false,
      })
    );
    expect(await servedByModelsApi()).toEqual(SFW_IDS);
  });

  it('serves SFW with a warning, and does not throw, when the settings read fails', async () => {
    primeOneModel({ minor: true, sfwOnly: false });
    redisMock.redis.get.mockRejectedValue(new Error('redis down'));
    expect(await servedByModelsApi()).toEqual(SFW_IDS);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        name: 'showcase-hold-settings-read',
        modelId: MODEL_ID,
      })
    );
  });
});

describe('/api/v1/model-versions — the hold as the version API calls it', () => {
  it('serves a minor model with stored gallery level 0 only within SFW', async () => {
    storedModel({ minor: true, gallerySettings: { level: 0 } });
    expect(await servedByVersionApi()).toEqual(SFW_IDS);
  });

  it('serves an unflagged model whole', async () => {
    storedModel({ gallerySettings: { level: 1 } });
    expect(await servedByVersionApi()).toEqual(ALL_IDS);
  });

  it('serves SFW with a warning, and does not throw, when the settings read fails', async () => {
    redisMock.redis.get.mockRejectedValue(new Error('redis down'));
    expect(await servedByVersionApi()).toEqual(SFW_IDS);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', name: 'showcase-hold-settings-read' })
    );
  });

  it('leaves the entries it is handed unchanged', async () => {
    storedModel({ minor: true, gallerySettings: { level: 0 } });
    const entry = { images: [...SHOWCASE] };
    const held = await holdShowcaseImages(
      { [VERSION_ID]: entry },
      new Map([[VERSION_ID, { modelId: MODEL_ID }]])
    );
    expect(held[VERSION_ID].images.map((i) => i.id)).toEqual(SFW_IDS);
    expect(entry.images.map((i) => i.id)).toEqual(ALL_IDS);
  });

  it('serves an unflagged row whole on a stale held settings entry', async () => {
    redisMock.redis.get.mockResolvedValue(
      JSON.stringify({
        hiddenTags: [],
        hiddenUsers: [],
        hiddenImages: {},
        pinnedPosts: {},
        level: 3,
        sfwHeld: true,
      })
    );
    const held = await holdShowcaseImages(
      { [VERSION_ID]: { images: SHOWCASE } },
      new Map([[VERSION_ID, { modelId: MODEL_ID, minor: false, sfwOnly: false }]])
    );
    expect(held[VERSION_ID].images.map((i) => i.id)).toEqual(ALL_IDS);
  });

  it('serves no images of a version with no model', async () => {
    const held = await holdShowcaseImages({ [VERSION_ID]: { images: SHOWCASE } }, new Map());
    expect(held[VERSION_ID].images).toEqual([]);
  });
});
