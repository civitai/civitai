import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { NsfwLevel } from '~/server/common/enums';
import type * as Caches from '~/server/redis/caches';
import type * as ReDerive from '~/server/services/blocks/app-listing-rating-rederive.service';

/**
 * A moderator re-rate reaches the cached version showcase: an entry holding the image at its old
 * level is replaced by one at the new level, through the real `bustCachesForPosts` and the real
 * `imagesForModelVersionsCache` over a faked cache cluster. The database is a mock that answers the
 * two queries this path makes: which version the image's post belongs to, and the showcase rebuild.
 */

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/blocks/app-listing-rating-rederive.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReDerive>()),
  reDeriveListingRatingsForModeratedImage: vi.fn(async () => []),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    refreshThumbnailCache: vi.fn(() => Promise.resolve()),
    imageMetadataCache: { ...actual.imageMetadataCache, refresh: vi.fn(() => Promise.resolve()) },
    tagIdsForImagesCache: { ...actual.tagIdsForImagesCache, fetch: vi.fn(async () => ({})) },
  };
});

const { updateImageNsfwLevel, imagesForModelVersionsCache } = await import('../image.service');

const VERSION = 811;
const POST = 8110;
const IMAGE = 81101;
const PREFIX = 'packed:caches:images-for-model-version-2:';

const showcaseImage = (nsfwLevel: number) => ({
  id: IMAGE,
  userId: 5,
  name: 'img',
  url: 'url',
  nsfwLevel,
  width: 512,
  height: 512,
  hash: 'hash',
  type: 'image',
  metadata: null,
  modelVersionId: VERSION,
});

let levelInDb: number;

beforeEach(() => {
  vi.clearAllMocks();
  const cache = installFakeCacheRedis();
  cache.plant(
    `${PREFIX}${VERSION}`,
    { modelVersionId: VERSION, images: [showcaseImage(NsfwLevel.PG)], cachedAt: new Date() },
    86400
  );
  levelInDb = NsfwLevel.PG;

  dbMock.dbWrite.image.findUnique.mockResolvedValue({
    metadata: {},
    postId: POST,
    nsfwLevel: NsfwLevel.PG,
  } as never);
  dbMock.dbWrite.image.update.mockImplementation((async (args: { data: { nsfwLevel: number } }) => {
    levelInDb = args.data.nsfwLevel;
    return {};
  }) as never);
  dbMock.dbWrite.model.findMany.mockResolvedValue([]);
  dbMock.dbWrite.$queryRaw.mockImplementation((async (query: { strings?: string[] } | string[]) => {
    const sql = (Array.isArray(query) ? query : query.strings ?? []).join('');
    if (sql.includes('"isShowcase"'))
      return [{ isShowcase: true, modelVersionId: VERSION, modelId: 81, model3dId: null }];
    if (sql.includes('WITH targets')) return [showcaseImage(levelInDb)];
    return [];
  }) as never);
});

describe('a moderator re-rate and the cached version showcase', () => {
  it('replaces the cached image at its old level with the new one', async () => {
    expect((await imagesForModelVersionsCache.fetch([VERSION]))[VERSION].images[0].nsfwLevel).toBe(
      NsfwLevel.PG
    );

    await updateImageNsfwLevel({
      id: IMAGE,
      nsfwLevel: NsfwLevel.X,
      userId: 9001,
      isModerator: true,
    } as never);

    expect((await imagesForModelVersionsCache.fetch([VERSION]))[VERSION].images[0].nsfwLevel).toBe(
      NsfwLevel.X
    );
  });
});
