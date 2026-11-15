import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { TokenScope } from '@civitai/auth/token-scope';
import { ApiKeyType } from '~/shared/utils/prisma/enums';
import { REDIS_KEYS } from '~/server/redis/client';
import type * as RedisCaches from '~/server/redis/caches';
import type * as UserService from '~/server/services/user.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { fetchShowcase, fetchDownloads } = vi.hoisted(() => ({
  fetchShowcase: vi.fn(),
  fetchDownloads: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { fetch: fetchShowcase },
  getImagesForModelVersionCache: fetchShowcase,
  getImagesForModelVersion: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  userDownloadsCache: { fetch: fetchDownloads },
  modelTagCache: { fetch: async () => ({}) },
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserSettings: async () => ({}),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: async () => ({}) }));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCategoryTags: async () => [],
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {}, pgDbReadLong: {} }));

// Static, so the large module graph loads at collection rather than inside one test's timeout.
const { getEligibleModels } = await import('~/server/services/eligible-models.service');
const { getUserDownloads } = await import('~/server/services/download.service');
const { pullModelsData, getModelSearchIndexRecords } = await import(
  '~/server/search-index/models.search-index'
);
const { getAuctionBySlug } = await import('~/server/services/auction.service');
const { getUserDownloadsHandler } = await import('~/server/controllers/download.controller');
const { holdShowcaseImages } = await import('~/server/services/model.service');

const HELD_MODEL = 5;
const OWNER = 50;
const VERSION = 10;
const SFW = NsfwLevel.PG | NsfwLevel.PG13;
const ABOVE = 1;
const WITHIN = 2;

/** Gallery settings reads answer from `entry` (null: a miss); other keys miss. */
function galleryReads(entry: (key: string) => string | null) {
  redisMock.redis.get.mockImplementation(async (key: string) =>
    key.startsWith(`${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:`) ? entry(key) : null
  );
}
function failGalleryReads() {
  redisMock.redis.get.mockImplementation(async (key: string) => {
    if (key.startsWith(`${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:`)) throw new Error('redis down');
    return null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset, not just cleared: a failing implementation must not reach the next test.
  redisMock.redis.get.mockReset();
  galleryReads((key) =>
    key === `${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:${HELD_MODEL}`
      ? JSON.stringify({ level: SFW, hiddenTags: [], hiddenUsers: [], sfwHeld: true })
      : null
  );
  // The showcase leads with an image above the held level, as a creator's often does.
  fetchShowcase.mockResolvedValue({
    [VERSION]: {
      modelVersionId: VERSION,
      images: [
        { id: ABOVE, nsfwLevel: NsfwLevel.X, url: 'x', modelVersionId: VERSION, userId: OWNER },
        { id: WITHIN, nsfwLevel: NsfwLevel.PG, url: 'pg', modelVersionId: VERSION, userId: OWNER },
      ],
    },
  });
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([
    {
      id: VERSION,
      modelId: HELD_MODEL,
      name: 'v1',
      baseModel: 'SDXL 1.0',
      model: {
        id: HELD_MODEL,
        name: 'held',
        type: 'LORA',
        userId: OWNER,
        minor: true,
        sfwOnly: false,
      },
      files: [],
    },
  ]);
  dbMock.dbRead.model.findMany.mockResolvedValue([{ id: HELD_MODEL, userId: OWNER }]);
});

describe("a held model's showcase on paths that read it from the shared cache", () => {
  it('a challenge shows the first image within the held level as the model cover', async () => {
    const [model] = await getEligibleModels([VERSION]);
    expect(model.image?.id).toBe(WITHIN);
  });

  it("download history shows another user a thumbnail within the held level, and the owner the creator's own", async () => {
    fetchDownloads.mockResolvedValue({
      [99]: { downloads: [{ modelVersionId: VERSION, fileId: 0, lastDownloaded: 1 }] },
      [OWNER]: { downloads: [{ modelVersionId: VERSION, fileId: 0, lastDownloaded: 1 }] },
    });
    const other = await getUserDownloads({ userId: 99, viewer: { id: 99, isModerator: false } });
    expect(other.items[0].image?.id).toBe(WITHIN);
    const owner = await getUserDownloads({
      userId: OWNER,
      viewer: { id: OWNER, isModerator: false },
    });
    expect(owner.items[0].image?.id).toBe(ABOVE);
  });

  it.each([
    { who: 'the owner, signed in', user: { id: OWNER }, credential: {}, image: ABOVE },
    {
      who: 'the owner, with a full-access key',
      user: { id: OWNER },
      credential: {
        apiKeyId: 1,
        apiKeyType: ApiKeyType.User,
        subject: { type: 'apiKey' },
        tokenScope: TokenScope.Full,
      },
      image: ABOVE,
    },
    {
      who: 'an app acting for the owner',
      user: { id: OWNER },
      credential: { apiKeyId: 1, apiKeyType: ApiKeyType.Access, subject: { type: 'oauth' } },
      image: WITHIN,
    },
    {
      who: 'a moderator, signed in',
      user: { id: 99, isModerator: true },
      credential: {},
      image: ABOVE,
    },
    {
      who: 'a moderator, with a scoped key',
      user: { id: 99, isModerator: true },
      credential: {
        apiKeyId: 1,
        apiKeyType: ApiKeyType.User,
        subject: { type: 'apiKey' },
        tokenScope: TokenScope.ModelsRead,
      },
      image: WITHIN,
    },
  ])(
    'download history shows $who the thumbnail it may see',
    async ({ user, credential, image }) => {
      fetchDownloads.mockResolvedValue({
        [user.id]: { downloads: [{ modelVersionId: VERSION, fileId: 0, lastDownloaded: 1 }] },
      });
      const ctx = { user, ...credential } as unknown as Parameters<
        typeof getUserDownloadsHandler
      >[0]['ctx'];
      const { items } = await getUserDownloadsHandler({ ctx });
      expect(items[0].image?.id).toBe(image);
    }
  );

  it('exempts the owner of a held model whose owner the caller did not name', async () => {
    const showcase: Record<number, { images: { id: number; nsfwLevel: number }[] }> =
      await fetchShowcase();
    const held = await holdShowcaseImages(
      showcase,
      new Map([[VERSION, { modelId: HELD_MODEL, minor: true, sfwOnly: false }]]),
      { id: OWNER, isModerator: false }
    );
    expect(held[VERSION].images.map((i) => i.id)).toEqual([ABOVE, WITHIN]);
  });

  it('serves none of the images of a version with no model', async () => {
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);
    const held = await holdShowcaseImages(await fetchShowcase(), new Map());
    expect(held[VERSION].images).toEqual([]);
  });

  it.each([
    { row: 'SFW-only', minor: false, sfwOnly: true, image: WITHIN },
    { row: 'unflagged', minor: false, sfwOnly: false, image: ABOVE },
  ])('download history of a $row model', async ({ minor, sfwOnly, image }) => {
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([
      {
        id: VERSION,
        modelId: HELD_MODEL,
        name: 'v1',
        baseModel: 'SDXL 1.0',
        model: { id: HELD_MODEL, name: 'model', type: 'LORA', userId: OWNER, minor, sfwOnly },
        files: [],
      },
    ]);
    fetchDownloads.mockResolvedValue({
      [99]: { downloads: [{ modelVersionId: VERSION, fileId: 0, lastDownloaded: 1 }] },
    });
    const history = await getUserDownloads({ userId: 99, viewer: { id: 99, isModerator: false } });
    expect(history.items[0].image?.id).toBe(image);
  });

  it('serves an unflagged model whole', async () => {
    galleryReads(() => JSON.stringify({ none: true }));
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([
      {
        id: VERSION,
        name: 'v1',
        baseModel: 'SDXL 1.0',
        model: { id: HELD_MODEL, name: 'm', minor: false, sfwOnly: false },
      },
    ]);
    const [model] = await getEligibleModels([VERSION]);
    expect(model.image?.id).toBe(ABOVE);
  });

  it('the models search document carries only images within the held level', async () => {
    const db = {
      model: { findMany: async () => [{ id: HELD_MODEL, modelVersions: [{ id: VERSION }] }] },
    };
    const data = await pullModelsData(
      { db, logger: () => undefined } as never,
      {
        type: 'update',
        ids: [HELD_MODEL],
      } as never
    );
    expect(data.images.map((image) => image.id)).toEqual([WITHIN]);
  });

  it.each([
    { row: 'minor', minor: true, sfwOnly: false, images: [WITHIN] },
    { row: 'SFW-only', minor: false, sfwOnly: true, images: [WITHIN] },
    { row: 'unflagged', minor: false, sfwOnly: false, images: [ABOVE, WITHIN] },
  ])(
    'the models search document of a $row row follows the row when its cached settings say it is not limited',
    async ({ minor, sfwOnly, images }) => {
      galleryReads(() => JSON.stringify({ none: true }));
      const db = {
        model: {
          findMany: async () => [
            { id: HELD_MODEL, minor, sfwOnly, modelVersions: [{ id: VERSION }] },
          ],
        },
      };
      const data = await pullModelsData(
        { db, logger: () => undefined } as never,
        {
          type: 'update',
          ids: [HELD_MODEL],
        } as never
      );
      expect(data.images.map((image) => image.id)).toEqual(images);
    }
  );

  it('the models search document carries only SFW images, without failing, when the gallery settings cannot be read', async () => {
    failGalleryReads();
    const db = {
      model: { findMany: async () => [{ id: HELD_MODEL, modelVersions: [{ id: VERSION }] }] },
    };
    const data = await pullModelsData(
      { db, logger: () => undefined } as never,
      { type: 'update', ids: [HELD_MODEL] } as never
    );
    expect((data as { images: { id: number }[] }).images.map((i) => i.id)).toEqual([WITHIN]);
  });

  it('a live read of the search records serves PG images only when the gallery settings cannot be read', async () => {
    failGalleryReads();
    dbMock.dbRead.model.findMany.mockResolvedValue([
      {
        id: HELD_MODEL,
        userId: OWNER,
        user: { id: OWNER },
        type: 'LORA',
        metrics: [],
        hashes: [],
        createdAt: new Date(0),
        nsfwLevel: 1,
        meta: null,
        modelVersions: [{ id: VERSION, files: [], metrics: [], hashes: [] }],
      },
    ]);
    const [record] = await getModelSearchIndexRecords([HELD_MODEL]);
    expect(record?.images.map((image) => image.id)).toEqual([WITHIN]);
  });

  function auctionOf(model: { minor: boolean }) {
    dbMock.dbWrite.auction.findFirst.mockResolvedValue({
      id: 1,
      quantity: 1,
      bids: [{ entityId: VERSION, amount: 10, deleted: false }],
    });
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([
      {
        id: VERSION,
        name: 'v1',
        model: {
          id: HELD_MODEL,
          name: 'model',
          meta: null,
          minor: model.minor,
          sfwOnly: false,
          user: { id: OWNER, profilePicture: null },
        },
      },
    ]);
    return getAuctionBySlug({ slug: 'featured' });
  }

  it.each([
    { row: 'minor', minor: true, image: WITHIN },
    { row: 'unflagged', minor: false, image: ABOVE },
  ])(
    'an auction card of a $row model follows the row when its cached settings say it is not limited',
    async ({ minor, image }) => {
      galleryReads(() => JSON.stringify({ none: true }));
      const auction = await auctionOf({ minor });
      expect(auction.bids[0].entityData?.image?.id).toBe(image);
    }
  );

  it('an auction card shows the first image within the held level, for every viewer', async () => {
    const auction = await auctionOf({ minor: true });
    expect(auction.bids[0].entityData?.image?.id).toBe(WITHIN);
  });

  it("a single model's search document update carries only images within the held level", async () => {
    dbMock.dbRead.model.findMany.mockResolvedValue([
      {
        id: HELD_MODEL,
        userId: OWNER,
        user: { id: OWNER },
        type: 'LORA',
        metrics: [],
        hashes: [],
        createdAt: new Date(0),
        nsfwLevel: 1,
        meta: null,
        modelVersions: [{ id: VERSION, files: [], metrics: [], hashes: [] }],
      },
    ]);
    const [record] = await getModelSearchIndexRecords([HELD_MODEL]);
    expect(record?.images.map((image) => image.id)).toEqual([WITHIN]);
  });
});
