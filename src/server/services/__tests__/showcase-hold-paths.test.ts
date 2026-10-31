import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
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
const { imageRouter } = await import('~/server/routers/image.router');
const { pullModelsData, getModelSearchIndexRecords } = await import(
  '~/server/search-index/models.search-index'
);
const { TokenScope } = await import('~/shared/constants/token-scope.constants');
const { getAuctionBySlug } = await import('~/server/services/auction.service');

const HELD_MODEL = 5;
const OWNER = 50;
const VERSION = 10;
const SFW = NsfwLevel.PG | NsfwLevel.PG13;
const ABOVE = 1;
const WITHIN = 2;

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.redis.mGet.mockImplementation(async (keys: string[]) =>
    keys.map((key) =>
      key === `${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:${HELD_MODEL}`
        ? JSON.stringify({ level: SFW, hiddenTags: [], hiddenUsers: [], sfwHeld: true })
        : null
    )
  );
  // The showcase leads with an image above the held level, as a creator's often does.
  fetchShowcase.mockResolvedValue({
    [VERSION]: {
      modelVersionId: VERSION,
      images: [
        { id: ABOVE, nsfwLevel: NsfwLevel.X, url: 'x', modelVersionId: VERSION },
        { id: WITHIN, nsfwLevel: NsfwLevel.PG, url: 'pg', modelVersionId: VERSION },
      ],
    },
  });
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([
    {
      id: VERSION,
      modelId: HELD_MODEL,
      name: 'v1',
      baseModel: 'SDXL 1.0',
      model: { id: HELD_MODEL, name: 'held', type: 'LORA', userId: OWNER },
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

  it('the version showcase procedure holds an app acting for the owner, not the owner signed in', async () => {
    const ids = async (ctx: object) =>
      (
        await imageRouter
          .createCaller({
            acceptableOrigin: true,
            tokenScope: TokenScope.Full,
            apiKeyId: null,
            req: { headers: {} },
            res: { setHeader: () => undefined },
            cache: { edgeTTL: 0 },
            features: {},
            track: { action: vi.fn(() => Promise.resolve(true)) },
            ...ctx,
          } as never)
          .getImagesForModelVersion({ id: VERSION })
      )[VERSION].images.map((image) => image.id);
    expect(await ids({ user: undefined })).toEqual([WITHIN]);
    expect(await ids({ user: { id: OWNER }, subject: { type: 'oauth' } })).toEqual([WITHIN]);
    expect(await ids({ user: { id: OWNER } })).toEqual([ABOVE, WITHIN]);
  });

  it("holds a viewer whose role changes while the request's showcase is being read", async () => {
    const user = { id: 99, isModerator: false };
    fetchShowcase.mockImplementationOnce(async () => {
      user.isModerator = true;
      return {
        [VERSION]: {
          modelVersionId: VERSION,
          images: [
            { id: ABOVE, nsfwLevel: NsfwLevel.X, url: 'x', modelVersionId: VERSION },
            { id: WITHIN, nsfwLevel: NsfwLevel.PG, url: 'pg', modelVersionId: VERSION },
          ],
        },
      };
    });
    const result = await imageRouter
      .createCaller({
        user,
        acceptableOrigin: true,
        tokenScope: TokenScope.Full,
        apiKeyId: null,
        req: { headers: {} },
        res: { setHeader: () => undefined },
        cache: { edgeTTL: 0 },
        features: {},
        track: { action: vi.fn(() => Promise.resolve(true)) },
      } as never)
      .getImagesForModelVersion({ id: VERSION });
    expect(result[VERSION].images.map((image) => image.id)).toEqual([WITHIN]);
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

  it('an auction card shows the first image within the held level, for every viewer', async () => {
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
          name: 'held',
          meta: null,
          user: { id: OWNER, profilePicture: null },
        },
      },
    ]);
    const auction = await getAuctionBySlug({ slug: 'featured' });
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
