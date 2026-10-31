import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type * as FliptClient from '~/server/flipt/client';

// Harness from model.service.vae-append-no-mutation.test.ts: drives the real getModelsRaw.
const VERSION_ID = 42;
const MODEL_ID = 7;
const OWNER = 5;

const { mockGetFilesForModelVersionCache, mockCancellableQuery, mockShowcase } = vi.hoisted(() => ({
  mockGetFilesForModelVersionCache: vi.fn(),
  mockCancellableQuery: vi.fn(),
  mockShowcase: vi.fn(),
}));

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
  getImagesForModelVersionCache: mockShowcase,
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn().mockResolvedValue(false),
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
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
vi.mock('~/server/services/cosmetic.service', () => ({
  getCosmeticsForEntity: vi.fn().mockResolvedValue({}),
  getEventDecorationsForEntity: vi.fn().mockResolvedValue({}),
}));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { fetch: vi.fn() },
  modelVersionPublicDonationGoalsCache: { fetch: vi.fn(), bust: vi.fn() },
  modelTagCache: { fetch: vi.fn(), bust: vi.fn() },
  modelVotableTagsCache: { fetch: vi.fn(), bust: vi.fn() },
  userBasicCache: { fetch: vi.fn().mockResolvedValue({}), bust: vi.fn() },
  userModelCountCache: { fetch: vi.fn(), bust: vi.fn() },
}));
import {
  getModelsWithImagesAndModelVersions,
  getModelsWithVersions,
} from '~/server/services/model.service';
import { dataForModelsCache } from '~/server/redis/caches';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mockDbRead = dbMock.dbRead;

const ABOVE = 1;
const WITHIN = 2;
const image = (id: number, nsfwLevel: number) => ({
  id,
  nsfwLevel,
  url: `u${id}`,
  name: null,
  width: 1,
  height: 1,
  hash: null,
  type: 'image',
  metadata: null,
  userId: OWNER,
  modelVersionId: VERSION_ID,
  postId: 1,
  tags: [],
});

/** One published model held at PG/PG13 whose showcase leads with an X image. */
function primeHeldModel() {
  mockCancellableQuery.mockResolvedValue({
    result: async () => [
      {
        id: MODEL_ID,
        userId: OWNER,
        name: 'Held',
        cursorId: null,
        meta: null,
        rank: {},
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
  redisMock.redis.mGet.mockResolvedValue([
    JSON.stringify({
      level: NsfwLevel.PG | NsfwLevel.PG13,
      hiddenTags: [],
      hiddenUsers: [],
      sfwHeld: true,
    }),
  ]);
  mockShowcase.mockResolvedValue({
    [VERSION_ID]: {
      modelVersionId: VERSION_ID,
      images: [image(ABOVE, NsfwLevel.X), image(WITHIN, NsfwLevel.PG)],
    },
  });
  mockDbRead.$queryRaw.mockResolvedValue([]);
  mockDbRead.modelMetric.findMany.mockResolvedValue([]);
  mockDbRead.modelVersionMetric.findMany.mockResolvedValue([]);
  mockDbRead.modelVersion.findMany.mockResolvedValue([{ id: VERSION_ID, meta: null }]);
  mockDbRead.recommendedResource.findMany.mockResolvedValue([]);
  mockDbRead.modelFile.findMany.mockResolvedValue([]);
  mockGetFilesForModelVersionCache.mockResolvedValue({
    [VERSION_ID]: {
      modelVersionId: VERSION_ID,
      files: [
        {
          id: 1,
          name: 'm.safetensors',
          type: 'Model',
          modelVersionId: VERSION_ID,
          metadata: {},
          hashes: [],
        },
      ],
    },
  });
}

const input = { browsingLevel: 31, take: 10, limit: 10, period: 'AllTime' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.redis.packed.get.mockResolvedValue(null);
  primeHeldModel();
});

describe('the public model API on a held model', () => {
  it('serves only showcase images within the held level, even to its owner', async () => {
    const { items } = await getModelsWithVersions({ input, user: { id: OWNER } });
    expect(items[0].modelVersions[0].images.map((i) => i.id)).toEqual([WITHIN]);
  });
});

describe('the model feed on a held model', () => {
  const imageIds = async (heldViewer?: { id: number; isModerator: boolean }) => {
    const { items } = await getModelsWithImagesAndModelVersions({
      input,
      heldViewer,
      coverage: { next: false, member: true } as never,
    });
    return items[0]?.images.map((i) => i.id);
  };

  it('shows another viewer only images within the held level', async () => {
    expect(await imageIds()).toEqual([WITHIN]);
    expect(await imageIds({ id: 99, isModerator: false })).toEqual([WITHIN]);
  });

  it('shows the owner and moderators the whole showcase', async () => {
    expect(await imageIds({ id: OWNER, isModerator: false })).toEqual([ABOVE, WITHIN]);
    expect(await imageIds({ id: 99, isModerator: true })).toEqual([ABOVE, WITHIN]);
  });

  it('drops the model for another viewer when its whole showcase is above the held level', async () => {
    mockShowcase.mockResolvedValue({
      [VERSION_ID]: { modelVersionId: VERSION_ID, images: [image(ABOVE, NsfwLevel.X)] },
    });
    expect(await imageIds()).toBeUndefined();
  });

  it("holds the creator's chosen cover from another version like any other image", async () => {
    const COVER = 3;
    const OTHER_VERSION = 43;
    mockCancellableQuery.mockResolvedValue({
      result: async () => [
        {
          id: MODEL_ID,
          userId: OWNER,
          name: 'Held',
          cursorId: null,
          meta: null,
          rank: {},
          coverImageId: COVER,
        },
      ],
    });
    mockDbRead.image.findMany.mockResolvedValue([
      {
        id: COVER,
        post: { userId: OWNER, modelVersionId: OTHER_VERSION, modelVersion: { modelId: MODEL_ID } },
      },
    ]);
    mockShowcase.mockImplementation(async (ids: number[]) =>
      ids.includes(OTHER_VERSION)
        ? {
            [OTHER_VERSION]: { modelVersionId: OTHER_VERSION, images: [image(COVER, NsfwLevel.X)] },
          }
        : { [VERSION_ID]: { modelVersionId: VERSION_ID, images: [image(WITHIN, NsfwLevel.PG)] } }
    );
    expect(await imageIds()).toEqual([WITHIN]);
    expect(await imageIds({ id: OWNER, isModerator: false })).toEqual([COVER, WITHIN]);
  });
});
