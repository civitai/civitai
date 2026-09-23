import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';

/**
 * Regression coverage: deleting an image must rebuild every collection that contained
 * it.
 *
 * `collections_v3` denormalizes an image per collection item, and the collections
 * index's incremental sweep only revisits NEWLY CREATED collections
 * (`c."createdAt" >= lastUpdatedAt` in prepareBatches). image.service had no
 * collections enqueue at all, so a collection whose cover item was a deleted image
 * kept serving a thumbnail that no longer resolves.
 *
 * `CollectionItem.imageId` is `onDelete: Cascade`, so the membership rows vanish with
 * the image — the resolve has to happen BEFORE the delete or there is nothing left to
 * read. That ordering is asserted below, not assumed.
 *
 * Fixture discipline: image ids, collection ids and post ids are pairwise distinct and
 * of different magnitudes, so a value read from the wrong variable cannot pass.
 */

const { mockCollectionsQueueUpdate, mockQueueImageSearchIndexUpdate, mockDeleteImageFromS3 } =
  vi.hoisted(() => ({
    mockCollectionsQueueUpdate: vi.fn(),
    mockQueueImageSearchIndexUpdate: vi.fn(),
    mockDeleteImageFromS3: vi.fn(),
  }));

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

// `articlesSearchIndex` is load-bearing here, not decoration: image.service imports it,
// so a factory that omits it leaves the module with a missing binding — the stale
// wholesale-mock shape that has broken suites elsewhere in this repo.
vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: mockCollectionsQueueUpdate },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

import * as imageService from '~/server/services/image.service';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { deleteImageById, deleteImages } = imageService;

const IMAGE_ID = 6631;
const OTHER_IMAGE_ID = 6684;
const POST_ID = 7012;
const OWNER_ID = 3307;
const COLLECTION_A = 8801;
const COLLECTION_B = 9107;

const mockDbWrite = dbMock.dbWrite;

const expectedUpdatePayload = (ids: number[]) =>
  ids.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }));

const isCollectionLookup = (strings: ArrayLike<string>) =>
  Array.from(strings).join('?').includes('"CollectionItem"');

// The image resolve asks the catalog whether the cover-leg index exists before it
// builds its query. These suites answer "yes" so they exercise the shape that runs
// once the migration is applied.
const isCoverIndexGate = (strings: ArrayLike<string>) =>
  Array.from(strings).join('?').includes('pg_class');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(imageService, 'queueImageSearchIndexUpdate').mockImplementation(
    mockQueueImageSearchIndexUpdate as never
  );
  vi.spyOn(imageService, 'deleteImageFromS3').mockImplementation(mockDeleteImageFromS3 as never);
});

describe('deleteImageById', () => {
  beforeEach(() => {
    mockDbWrite.image.delete.mockResolvedValue({
      url: 'some-url',
      postId: POST_ID,
      nsfwLevel: 1,
      userId: OWNER_ID,
    });
    mockDbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      if (isCoverIndexGate(strings)) return [{ present: true }];
      return isCollectionLookup(strings)
        ? [{ collectionId: COLLECTION_A }, { collectionId: COLLECTION_B }]
        : [];
    });
  });

  it('queues an Update for every collection that contained the deleted image', async () => {
    await deleteImageById({ id: IMAGE_ID, updatePost: false });

    expect(mockCollectionsQueueUpdate).toHaveBeenCalledWith(
      expectedUpdatePayload([COLLECTION_A, COLLECTION_B])
    );
  });

  it('resolves the collections BEFORE the delete, since CollectionItem cascades away', async () => {
    const order: string[] = [];
    mockDbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      if (!isCollectionLookup(strings)) return [];
      order.push('resolve');
      return [{ collectionId: COLLECTION_A }];
    });
    mockDbWrite.image.delete.mockImplementation(async () => {
      order.push('delete');
      return { url: 'some-url', postId: POST_ID, nsfwLevel: 1, userId: OWNER_ID };
    });

    await deleteImageById({ id: IMAGE_ID, updatePost: false });

    expect(order).toEqual(['resolve', 'delete']);
  });

  it('resolves by the deleted image id', async () => {
    await deleteImageById({ id: IMAGE_ID, updatePost: false });

    const call = mockDbWrite.$queryRaw.mock.calls.find(([strings]: [string[]]) =>
      isCollectionLookup(strings)
    );
    expect(call).toBeDefined();
    expect((call as unknown[])[0].join('?')).toContain('"imageId"');
    const boundValues = (call as unknown[])
      .slice(1)
      .flatMap((v) => (v && typeof v === 'object' && 'values' in v ? (v as any).values : [v]));
    expect(boundValues).toContain(IMAGE_ID);
  });

  it('still deletes the image when the collections lookup fails', async () => {
    mockDbWrite.$queryRaw.mockRejectedValue(new Error('connection reset'));

    await deleteImageById({ id: IMAGE_ID, updatePost: false });

    expect(mockDbWrite.image.delete).toHaveBeenCalled();
    expect(mockCollectionsQueueUpdate).not.toHaveBeenCalled();
  });
});

describe('deleteImages — bulk', () => {
  beforeEach(() => {
    mockDbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      isCoverIndexGate(strings)
        ? [{ present: true }]
        : isCollectionLookup(strings)
        ? [{ collectionId: COLLECTION_B }, { collectionId: COLLECTION_A }]
        : [
            { id: IMAGE_ID, url: 'a', postId: POST_ID, nsfwLevel: 1, userId: OWNER_ID },
            { id: OTHER_IMAGE_ID, url: 'b', postId: POST_ID, nsfwLevel: 1, userId: OWNER_ID },
          ]
    );
  });

  it('queues an Update for every collection holding any of the deleted images', async () => {
    await deleteImages([IMAGE_ID, OTHER_IMAGE_ID], false);

    expect(mockCollectionsQueueUpdate).toHaveBeenCalledWith(
      expectedUpdatePayload([COLLECTION_B, COLLECTION_A])
    );
  });

  it('resolves the collections before issuing the bulk DELETE', async () => {
    const order: string[] = [];
    mockDbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join('?');
      if (isCollectionLookup(strings)) {
        order.push('resolve');
        return [{ collectionId: COLLECTION_A }];
      }
      // Only the image DELETE is timed; the path issues other raw statements
      // afterwards that say nothing about this ordering.
      if (sql.includes('DELETE FROM "Image"')) {
        order.push('delete');
        return [{ id: IMAGE_ID, url: 'a', postId: POST_ID, nsfwLevel: 1, userId: OWNER_ID }];
      }
      return [];
    });

    await deleteImages([IMAGE_ID], false);

    expect(order).toEqual(['resolve', 'delete']);
  });

  // `deleteImages` has no try/catch of its own and the resolve is its FIRST statement,
  // so the whole bulk delete — the DELETE itself, the index de-queue and the S3
  // cleanup that follows — rests on the resolve never throwing. Nothing else in this
  // suite would notice if that contract broke.
  it('still issues the bulk DELETE when the collections lookup fails', async () => {
    const seen: string[] = [];
    mockDbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join('?');
      if (isCoverIndexGate(strings)) throw new Error('connection reset');
      if (sql.includes('DELETE FROM "Image"')) {
        seen.push('delete');
        return [{ id: IMAGE_ID, url: 'a', postId: POST_ID, nsfwLevel: 1, userId: OWNER_ID }];
      }
      return [];
    });

    // Asserted on the statements the path issues rather than on the intra-module
    // helpers: `vi.spyOn(imageService, …)` cannot intercept a call image.service makes
    // to its own binding, so a "was deleteImageFromS3 called" assertion would be
    // unobservable here and would pass or fail for reasons unrelated to this contract.
    const result = await deleteImages([IMAGE_ID], false);

    expect(seen).toEqual(['delete']);
    expect(result).toBeDefined();
    expect(mockCollectionsQueueUpdate).not.toHaveBeenCalled();
  });
});
