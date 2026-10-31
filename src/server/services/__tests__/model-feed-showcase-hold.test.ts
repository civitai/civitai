import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type * as FliptClient from '~/server/flipt/client';

// Harness from model.service.vae-append-no-mutation.test.ts: drives the real getModelsRaw.
const VERSION_ID = 42;
const MODEL_ID = 7;
const OWNER = 5;

const {
  mockGetFilesForModelVersionCache,
  mockCancellableQuery,
  mockShowcase,
  mockPendingShowcase,
} = vi.hoisted(() => ({
  mockGetFilesForModelVersionCache: vi.fn(),
  mockCancellableQuery: vi.fn(),
  mockShowcase: vi.fn(),
  mockPendingShowcase: vi.fn(),
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
  getImagesForModelVersion: mockPendingShowcase,
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

const GALLERY = 'model:gallery-settings:';
/** Gallery settings reads answer from `entry`; other keys miss. */
function galleryReads(entry: () => string) {
  redisMock.redis.get.mockImplementation(async (key: string) =>
    key.startsWith(GALLERY) ? entry() : null
  );
}
function failGalleryReads() {
  redisMock.redis.get.mockImplementation(async (key: string) => {
    if (key.startsWith(GALLERY)) throw new Error('redis down');
    return null;
  });
}

/** One published model held at PG/PG13 whose showcase leads with an X image. */
function primeHeldModel() {
  mockCancellableQuery.mockResolvedValue({
    result: async () => [
      {
        id: MODEL_ID,
        userId: OWNER,
        name: 'Held',
        minor: false,
        sfwOnly: true,
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
  galleryReads(() =>
    JSON.stringify({
      level: NsfwLevel.PG | NsfwLevel.PG13,
      hiddenTags: [],
      hiddenUsers: [],
      sfwHeld: true,
    })
  );
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
  // Reset, not just cleared: a failing implementation must not reach the next test.
  redisMock.redis.get.mockReset();
  redisMock.redis.packed.get.mockResolvedValue(null);
  primeHeldModel();
});

describe('the public model API on a held model', () => {
  it('serves only showcase images within the held level, even to its owner', async () => {
    const { items } = await getModelsWithVersions({ input, user: { id: OWNER } });
    expect(items[0].modelVersions[0].images.map((i) => i.id)).toEqual([WITHIN]);
  });

  const rowWith = (flags: { minor: boolean; sfwOnly: boolean }) =>
    mockCancellableQuery.mockResolvedValue({
      result: async () => [
        { id: MODEL_ID, userId: OWNER, name: 'M', ...flags, cursorId: null, meta: null, rank: {} },
      ],
    });

  it('holds a model its row reads as minor only', async () => {
    rowWith({ minor: true, sfwOnly: false });
    const { items } = await getModelsWithVersions({ input });
    expect(items[0].modelVersions[0].images.map((i) => i.id)).toEqual([WITHIN]);
  });

  it('reads no gallery settings for a model its row reads as unflagged', async () => {
    rowWith({ minor: false, sfwOnly: false });
    const { items } = await getModelsWithVersions({ input });
    expect(items[0].modelVersions[0].images.map((i) => i.id)).toEqual([ABOVE, WITHIN]);
    expect(
      redisMock.redis.get.mock.calls.filter(([key]) => String(key).startsWith(GALLERY))
    ).toEqual([]);
  });

  it('serves only images within the held level to a moderator too', async () => {
    const { items } = await getModelsWithVersions({ input, user: { id: 99, isModerator: true } });
    expect(items[0].modelVersions[0].images.map((i) => i.id)).toEqual([WITHIN]);
  });

  it('serves PG images only, without failing, when the gallery settings cannot be read', async () => {
    failGalleryReads();
    const { items } = await getModelsWithVersions({ input });
    expect(items[0].modelVersions[0].images.map((i) => i.id)).toEqual([WITHIN]);
  });

  it('serves a model without the flags whole', async () => {
    galleryReads(() => JSON.stringify({ none: true }));
    const { items } = await getModelsWithVersions({ input });
    expect(items[0].modelVersions[0].images.map((i) => i.id)).toEqual([ABOVE, WITHIN]);
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

  it('holds a model its row reads as minor only', async () => {
    mockCancellableQuery.mockResolvedValue({
      result: async () => [
        {
          id: MODEL_ID,
          userId: OWNER,
          name: 'M',
          minor: true,
          sfwOnly: false,
          cursorId: null,
          meta: null,
          rank: {},
        },
      ],
    });
    expect(await imageIds()).toEqual([WITHIN]);
  });

  it('reads no gallery settings for a page of models without the flags', async () => {
    mockCancellableQuery.mockResolvedValue({
      result: async () => [
        {
          id: MODEL_ID,
          userId: OWNER,
          name: 'Open',
          minor: false,
          sfwOnly: false,
          cursorId: null,
          meta: null,
          rank: {},
        },
      ],
    });
    expect(await imageIds()).toEqual([ABOVE, WITHIN]);
    const galleryReads = redisMock.redis.get.mock.calls.filter(([key]) =>
      String(key).startsWith(GALLERY)
    );
    expect(galleryReads).toEqual([]);
  });

  it('shows every viewer the whole showcase of a model without the flags', async () => {
    galleryReads(() => JSON.stringify({ none: true }));
    expect(await imageIds()).toEqual([ABOVE, WITHIN]);
  });

  it('shows another viewer only images within the held level', async () => {
    expect(await imageIds()).toEqual([WITHIN]);
    expect(await imageIds({ id: 99, isModerator: false })).toEqual([WITHIN]);
  });

  it('serves the page with PG images only when the gallery settings cannot be read', async () => {
    failGalleryReads();
    mockShowcase.mockResolvedValue({
      [VERSION_ID]: {
        modelVersionId: VERSION_ID,
        images: [image(ABOVE, NsfwLevel.X), image(3, NsfwLevel.PG13), image(WITHIN, NsfwLevel.PG)],
      },
    });
    expect(await imageIds()).toEqual([WITHIN]);
  });

  it('shows the owner and moderators the whole showcase', async () => {
    expect(await imageIds({ id: OWNER, isModerator: false })).toEqual([ABOVE, WITHIN]);
    expect(await imageIds({ id: 99, isModerator: true })).toEqual([ABOVE, WITHIN]);
  });

  it('holds a pending feed read, which reads images outside the shared cache', async () => {
    mockPendingShowcase.mockResolvedValue([image(ABOVE, NsfwLevel.X), image(WITHIN, NsfwLevel.PG)]);
    const { items } = await getModelsWithImagesAndModelVersions({
      input: { ...(input as object), pending: true } as never,
      heldViewer: { id: 99, isModerator: false },
      coverage: { next: false, member: true } as never,
    });
    expect(mockPendingShowcase).toHaveBeenCalled();
    expect(mockShowcase).not.toHaveBeenCalled();
    expect(items[0]?.images.map((i) => i.id)).toEqual([WITHIN]);
  });

  it('reads the shared showcase cache for the shown versions only, whoever is viewing', async () => {
    await imageIds();
    await imageIds({ id: OWNER, isModerator: false });
    expect(mockShowcase.mock.calls).toEqual([[[VERSION_ID]], [[VERSION_ID]]]);
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
          minor: false,
          sfwOnly: true,
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
