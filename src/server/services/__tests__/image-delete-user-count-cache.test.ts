import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as UserService from '~/server/services/user.service';

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
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

// The profile-picture reads and refresh live in user.service, so they can be observed here.
const { getProfilePictureUserIds, refreshProfilePicturesForUsers } = vi.hoisted(() => ({
  getProfilePictureUserIds: vi.fn(async (_ids: number[]) => [] as number[]),
  refreshProfilePicturesForUsers: vi.fn(async (_userIds: number[]) => undefined),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getProfilePictureUserIds,
  refreshProfilePicturesForUsers,
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
import { imagesMetricsSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

const { deleteImages } = imageService;

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
  bustSpy = vi.spyOn(userImageVideoCountCaches, 'bust').mockResolvedValue(undefined);
  thumbnailRefreshSpy = vi.spyOn(thumbnailCache, 'refresh').mockResolvedValue(undefined as never);
  getProfilePictureUserIds.mockReset().mockResolvedValue([]);
  refreshProfilePicturesForUsers.mockReset().mockResolvedValue(undefined);
});

// The single delete is one raw statement; every other raw read here answers empty.
const deleteReturns = (row: Record<string, unknown> | Error) =>
  mockDbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) => {
    if (!Array.from(strings).join('?').includes('DELETE FROM "Image"')) return [];
    if (row instanceof Error) throw row;
    return [row];
  }) as never);

describe('deleteImages — one image', () => {
  it("busts the owner's image/video count cache", async () => {
    deleteReturns({
      id: IMAGE_ID,
      url: 'some-url',
      postId: POST_ID,
      nsfwLevel: 1,
      userId: OWNER_ID,
    });

    await deleteImages([IMAGE_ID], { actor: { system: 'test' } });

    expect(bustSpy).toHaveBeenCalledTimes(1);
    expect(bustSpy).toHaveBeenCalledWith([OWNER_ID]);
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

    await expect(deleteImages([IMAGE_ID], { actor: { system: 'test' } })).resolves.toEqual([]);

    expect(vi.mocked(imagesMetricsSearchIndex.queueUpdate)).toHaveBeenCalledWith([
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

  // Already gone: no kept record and no row, so it leaves search and nothing else runs for it.
  it('drops a row that was already gone from search, and stops there', async () => {
    mockDbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
      Array.from(strings).join('?').includes('DELETE FROM "Image"')
        ? [{ id: IMAGE_ID, outcome: 'gone' }]
        : []) as never);

    await expect(deleteImages([IMAGE_ID], { actor: { system: 'test' } })).resolves.toEqual([]);

    expect(vi.mocked(imagesMetricsSearchIndex.queueUpdate)).toHaveBeenCalledWith([
      { id: IMAGE_ID, action: SearchIndexUpdateQueueAction.Delete },
    ]);
    // The post-commit finish busts the (empty) list of deleted rows' owners: no owner is named.
    expect(bustSpy.mock.calls.flatMap(([ids]: unknown[]) => [ids].flat())).toEqual([]);
  });

  it('does not treat any other delete failure as a removed row', async () => {
    deleteReturns(new Error('connection reset'));

    await expect(deleteImages([IMAGE_ID], { actor: { system: 'test' } })).rejects.toThrow(
      'connection reset'
    );

    expect(vi.mocked(imagesMetricsSearchIndex.queueUpdate)).not.toHaveBeenCalled();
  });
});

describe('deleting a custom video thumbnail', () => {
  // The cache is keyed by the video; once the thumbnail row is gone nothing else can name it.
  // The search-index delete also refreshes the deleted ids themselves, so only the parent-id
  // calls are counted here.
  const parentRefreshes = () =>
    thumbnailRefreshSpy.mock.calls.filter(
      ([ids]: unknown[]) => ids === 900 || (Array.isArray(ids) && ids.includes(900))
    );
  it('refreshes the parent video’s thumbnail entry on a single delete', async () => {
    deleteReturns({
      url: 'thumb',
      postId: null,
      nsfwLevel: 1,
      userId: OWNER_ID,
      metadata: { parentId: 900 },
      parentId: 900,
    });

    await deleteImages([IMAGE_ID], { actor: { system: 'test' } });

    expect(thumbnailRefreshSpy).toHaveBeenCalledWith([900]);
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

    await deleteImages([IMAGE_ID, OTHER_IMAGE_ID, THIRD_IMAGE_ID], {
      actor: { system: 'test' },
    });

    expect(parentRefreshes()).toEqual([[[900]]]);

    const deleteCall = mockDbWrite.$queryRaw.mock.calls.find((call) =>
      Array.from(call[0] as string[])
        .join('?')
        .includes('DELETE FROM "Image"')
    ) as [string[]];
    expect(Array.from(deleteCall[0]).join('?')).toMatch(/RETURNING[^;]*"parentId"/);
  });

  it('refreshes nothing when no deleted image was a thumbnail', async () => {
    deleteReturns({ url: 'img', postId: null, nsfwLevel: 1, userId: OWNER_ID, metadata: {} });

    await deleteImages([IMAGE_ID], { actor: { system: 'test' } });

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

    await deleteImages([IMAGE_ID, OTHER_IMAGE_ID, THIRD_IMAGE_ID], {
      actor: { system: 'test' },
    });

    expect(bustSpy).toHaveBeenCalledTimes(1);
    expect(bustSpy).toHaveBeenCalledWith([OWNER_ID, OTHER_OWNER_ID]);

    // The fixture rows supply userId regardless, and the $queryRaw type annotation can't catch a dropped column.
    const deleteCall = mockDbWrite.$queryRaw.mock.calls.find((call) =>
      Array.from(call[0] as string[])
        .join('?')
        .includes('DELETE FROM "Image"')
    ) as [string[]];
    expect(Array.from(deleteCall[0]).join('?')).toMatch(/RETURNING[^;]*"userId"/);
  });
});

const BULK_ROWS = [
  { id: IMAGE_ID, url: 'a', postId: POST_ID, nsfwLevel: 1, userId: OWNER_ID, parentId: null },
  { id: OTHER_IMAGE_ID, url: 'b', postId: null, nsfwLevel: 1, userId: OWNER_ID, parentId: null },
];
const bulkDeleteReturns = () =>
  mockDbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
    Array.from(strings).join('?').includes('DELETE FROM "Image"') ? BULK_ROWS : []
  );

describe('deleteImages — profile pictures', () => {
  // The delete nulls `User.profilePictureId`, so the owners are read first and refreshed after.
  it('refreshes the profile picture of every user whose picture was deleted', async () => {
    bulkDeleteReturns();
    getProfilePictureUserIds.mockResolvedValue([OWNER_ID]);

    await deleteImages([IMAGE_ID, OTHER_IMAGE_ID], { actor: { system: 'test' } });

    expect(getProfilePictureUserIds).toHaveBeenCalledWith([IMAGE_ID, OTHER_IMAGE_ID]);
    expect(refreshProfilePicturesForUsers).toHaveBeenCalledWith([OWNER_ID]);
  });

  it('still deletes, refreshing no one, when the profile-picture read fails', async () => {
    bulkDeleteReturns();
    getProfilePictureUserIds.mockRejectedValue(new Error('connection reset'));

    await expect(
      deleteImages([IMAGE_ID, OTHER_IMAGE_ID], { actor: { system: 'test' } })
    ).resolves.toEqual(BULK_ROWS);

    expect(refreshProfilePicturesForUsers).toHaveBeenCalledWith([]);
  });
});

describe('deleteImages — cleanup after the commit', () => {
  // The rows are gone once the transaction commits: a failed cache bust must not turn the delete
  // into an error the caller retries or reports.
  it('resolves with the deleted rows when cache busts fail, and logs the failure', async () => {
    bulkDeleteReturns();
    bustSpy.mockRejectedValue(new Error('redis down'));
    vi.spyOn(imageMetaCache, 'refresh').mockRejectedValue(new Error('redis down'));

    await expect(
      deleteImages([IMAGE_ID, OTHER_IMAGE_ID], { actor: { system: 'test' } })
    ).resolves.toEqual(BULK_ROWS);

    expect(vi.mocked(imagesMetricsSearchIndex.queueUpdate)).toHaveBeenCalledWith([
      { id: IMAGE_ID, action: SearchIndexUpdateQueueAction.Delete },
      { id: OTHER_IMAGE_ID, action: SearchIndexUpdateQueueAction.Delete },
    ]);
  });
});
