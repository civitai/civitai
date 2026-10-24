import { Prisma } from '@prisma/client';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';

/**
 * Regression coverage: deleting images must bust the owner's image/video count cache,
 * or the profile Images tab keeps the pre-delete count for the cache's 24h TTL.
 */

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

import * as imageService from '~/server/services/image.service';
import * as postService from '~/server/services/post.service';
import {
  imageMetaCache,
  imageMetadataCache,
  thumbnailCache,
  userImageVideoCountCaches,
} from '~/server/redis/caches';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { imagesSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

const { deleteImageById, deleteImages } = imageService;

const IMAGE_ID = 6631;
const OTHER_IMAGE_ID = 6684;
const THIRD_IMAGE_ID = 6702;
const POST_ID = 7012;
const OWNER_ID = 3307;
const OTHER_OWNER_ID = 4419;

const mockDbWrite = dbMock.dbWrite;

let bustSpy: ReturnType<typeof vi.spyOn>;
let thumbnailRefreshSpy: ReturnType<typeof vi.spyOn>;

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(imageService, 'queueImageSearchIndexUpdate').mockResolvedValue(undefined as never);
  vi.spyOn(imageService, 'deleteImageFromS3').mockResolvedValue(undefined as never);
  bustSpy = vi.spyOn(userImageVideoCountCaches, 'bust').mockResolvedValue(undefined);
  thumbnailRefreshSpy = vi.spyOn(thumbnailCache, 'refresh').mockResolvedValue(undefined as never);
});

describe('deleteImageById', () => {
  it("busts the owner's image/video count cache", async () => {
    mockDbWrite.$queryRaw.mockResolvedValue([]);
    mockDbWrite.image.delete.mockResolvedValue({
      url: 'some-url',
      postId: POST_ID,
      nsfwLevel: 1,
      userId: OWNER_ID,
    });

    await deleteImageById({ id: IMAGE_ID });

    expect(bustSpy).toHaveBeenCalledTimes(1);
    expect(bustSpy).toHaveBeenCalledWith(OWNER_ID);
  });

  // A hold marker's delete trigger kept the row, blocked it and took it out of its post: every
  // cache a delete busts is stale for it too, its post's included.
  it("busts a kept row's caches and its post's", async () => {
    const postBust = vi.spyOn(postService, 'bustCachesForPosts').mockResolvedValue(undefined);
    const metaRefresh = vi.spyOn(imageMetaCache, 'refresh').mockResolvedValue(undefined as never);
    const metadataRefresh = vi
      .spyOn(imageMetadataCache, 'refresh')
      .mockResolvedValue(undefined as never);
    // Answers the kept-record lookup only for the id it binds.
    mockDbWrite.$queryRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) =>
      strings.join('?').includes('"EvidenceHoldImage"') &&
      JSON.stringify(values).includes(String(IMAGE_ID))
        ? [{ imageId: IMAGE_ID, userId: OWNER_ID, postId: POST_ID }]
        : []) as never);
    mockDbWrite.image.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('not found', { code: 'P2025', clientVersion: 'x' })
    );

    await expect(deleteImageById({ id: IMAGE_ID })).resolves.toBeUndefined();

    expect(vi.mocked(imagesSearchIndex.queueUpdate)).toHaveBeenCalledWith([
      { id: IMAGE_ID, action: SearchIndexUpdateQueueAction.Delete },
    ]);
    expect(bustSpy).toHaveBeenCalledWith([OWNER_ID]);
    expect(postBust).toHaveBeenCalledWith([POST_ID]);
    expect(metaRefresh).toHaveBeenCalledWith([IMAGE_ID]);
    expect(metadataRefresh).toHaveBeenCalledWith([IMAGE_ID]);
    // The existence cache is what takes a blocked image off the site.
    expect(vi.mocked(redisMock.sysRedis.packed.set)).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`:${IMAGE_ID}$`)),
      'false',
      expect.anything()
    );
  });

  // Already gone: no kept record, so it leaves search and nothing else runs for it.
  it('drops a row the delete did not remove from search, and stops there', async () => {
    mockDbWrite.$queryRaw.mockResolvedValue([]);
    mockDbWrite.image.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('not found', { code: 'P2025', clientVersion: 'x' })
    );

    await expect(deleteImageById({ id: IMAGE_ID })).resolves.toBeUndefined();

    expect(vi.mocked(imagesSearchIndex.queueUpdate)).toHaveBeenCalledWith([
      { id: IMAGE_ID, action: SearchIndexUpdateQueueAction.Delete },
    ]);
    expect(bustSpy).not.toHaveBeenCalled();
  });

  it('does not treat any other delete failure as a removed row', async () => {
    mockDbWrite.$queryRaw.mockResolvedValue([]);
    mockDbWrite.image.delete.mockRejectedValue(new Error('connection reset'));

    await deleteImageById({ id: IMAGE_ID });

    expect(vi.mocked(imagesSearchIndex.queueUpdate)).not.toHaveBeenCalled();
  });
});

describe('deleting a custom video thumbnail', () => {
  // The cache is keyed by the video; once the thumbnail row is gone nothing else can name it.
  // The search-index delete also refreshes the deleted ids themselves, so only the parent-id
  // calls are counted here.
  const parentRefreshes = () =>
    thumbnailRefreshSpy.mock.calls.filter(
      ([ids]) => ids === 900 || (Array.isArray(ids) && ids.includes(900))
    );
  it('refreshes the parent video’s thumbnail entry on a single delete', async () => {
    mockDbWrite.$queryRaw.mockResolvedValue([]);
    mockDbWrite.image.delete.mockResolvedValue({
      url: 'thumb',
      postId: null,
      nsfwLevel: 1,
      userId: OWNER_ID,
      metadata: { parentId: 900 },
    });

    await deleteImageById({ id: IMAGE_ID });

    expect(thumbnailRefreshSpy).toHaveBeenCalledWith(900);
  });

  it('refreshes each parent video once on a bulk delete, and nothing for plain images', async () => {
    mockDbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      Array.from(strings).join('?').includes('DELETE FROM "Image"')
        ? [
            { id: IMAGE_ID, url: 'a', postId: null, nsfwLevel: 1, userId: OWNER_ID, parentId: 900 },
            {
              id: OTHER_IMAGE_ID,
              url: 'b',
              postId: null,
              nsfwLevel: 1,
              userId: OWNER_ID,
              parentId: 900,
            },
            {
              id: THIRD_IMAGE_ID,
              url: 'c',
              postId: null,
              nsfwLevel: 1,
              userId: OWNER_ID,
              parentId: null,
            },
          ]
        : []
    );

    await deleteImages([IMAGE_ID, OTHER_IMAGE_ID, THIRD_IMAGE_ID]);

    expect(parentRefreshes()).toEqual([[[900]]]);

    const deleteCall = mockDbWrite.$queryRaw.mock.calls.find(([strings]: [string[]]) =>
      Array.from(strings).join('?').includes('DELETE FROM "Image"')
    ) as [string[]];
    expect(Array.from(deleteCall[0]).join('?')).toMatch(/RETURNING[^;]*"parentId"/);
  });

  it('refreshes nothing when no deleted image was a thumbnail', async () => {
    mockDbWrite.$queryRaw.mockResolvedValue([]);
    mockDbWrite.image.delete.mockResolvedValue({
      url: 'img',
      postId: null,
      nsfwLevel: 1,
      userId: OWNER_ID,
      metadata: {},
    });

    await deleteImageById({ id: IMAGE_ID });

    expect(parentRefreshes()).toEqual([]);
  });
});

describe('deleteImages — bulk', () => {
  it('busts the count cache once per distinct owner of the deleted images', async () => {
    mockDbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      Array.from(strings).join('?').includes('DELETE FROM "Image"')
        ? [
            { id: IMAGE_ID, url: 'a', postId: POST_ID, nsfwLevel: 1, userId: OWNER_ID },
            { id: OTHER_IMAGE_ID, url: 'b', postId: POST_ID, nsfwLevel: 1, userId: OWNER_ID },
            { id: THIRD_IMAGE_ID, url: 'c', postId: null, nsfwLevel: 1, userId: OTHER_OWNER_ID },
          ]
        : []
    );

    await deleteImages([IMAGE_ID, OTHER_IMAGE_ID, THIRD_IMAGE_ID]);

    expect(bustSpy).toHaveBeenCalledTimes(1);
    expect(bustSpy).toHaveBeenCalledWith([OWNER_ID, OTHER_OWNER_ID]);

    // The fixture rows supply userId regardless, and the $queryRaw type annotation can't catch a dropped column.
    const deleteCall = mockDbWrite.$queryRaw.mock.calls.find(([strings]: [string[]]) =>
      Array.from(strings).join('?').includes('DELETE FROM "Image"')
    ) as [string[]];
    expect(Array.from(deleteCall[0]).join('?')).toMatch(/RETURNING[^;]*"userId"/);
  });
});
