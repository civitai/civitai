import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression tests for the three concurrency races in `toggleBookmarked` (the shared
// bookmark-toggle helper behind toggleFavorite / toggleBookmarkedArticle / the Image/Post
// controller callers). It is the ~1.3/day HTTP-500 residual on user.toggleFavorite — the tail
// after #2816/#2798 cleared modelEngagement + resourceReview.
//
// All three hit prod-only PARTIAL UNIQUE indexes that are NOT in the Prisma schema:
//   #1 collection.create     → `User_bookmark_collection UNIQUE (userId,type,mode) WHERE mode='Bookmark'` (P2002)
//   #2 collectionItem.create → `CollectionItem_model UNIQUE (collectionId,modelId) WHERE modelId IS NOT NULL` (+image/post/article) (P2002)
//   #3 collectionItem.delete → P2025 "record not found" when two un-bookmarks delete the same row
//
// Fixes: #3 delete→deleteMany (idempotent {count}), #2 create→createMany({skipDuplicates:true})
// (ON CONFLICT DO NOTHING), #1 catch P2002 + re-fetch (Prisma upsert can't target a partial index).

import { Prisma } from '@prisma/client';

const { mockDb, queueUpdate } = vi.hoisted(() => ({
  mockDb: {
    collection: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 999 })),
    },
    collectionItem: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 1 })),
      createMany: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ count: 1 })),
      delete: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      deleteMany: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ count: 1 })),
    },
  },
  queueUpdate: vi.fn(() => undefined),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
// `toggleBookmarked` calls metricsEngine.queueUpdate on the delete path. Stub the metrics module
// surface user.service reaches at import time.
vi.mock('~/server/metrics', () => ({
  articleMetrics: { queueUpdate },
  imageMetrics: { queueUpdate },
  modelMetrics: { queueUpdate },
  postMetrics: { queueUpdate },
  userMetrics: { queueUpdate },
}));
// Mirrors the engagement-toggle test: stub the user-preferences module surface user.service
// reaches at import time so module load doesn't pull in the real cache layer.
vi.mock('~/server/services/user-preferences.service', () => ({
  HiddenModels: { refreshCache: vi.fn(async () => undefined) },
  HiddenModels3D: { refreshCache: vi.fn(async () => undefined) },
  HiddenUsers: { refreshCache: vi.fn(async () => undefined) },
  HiddenImages: { refreshCache: vi.fn(async () => undefined) },
  HiddenTags: { refreshCache: vi.fn(async () => undefined) },
  BlockedUsers: { refreshCache: vi.fn(async () => undefined), getCached: vi.fn(async () => []) },
  BlockedByUsers: { refreshCache: vi.fn(async () => undefined) },
  ImplicitHiddenImages: { refreshCache: vi.fn(async () => undefined) },
  toggleHidden: vi.fn(async () => ({ added: [], removed: [] })),
}));

import { toggleBookmarked } from '~/server/services/user.service';
import { CollectionType } from '~/shared/utils/prisma/enums';

const p2002 = (target: string[]) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '1',
    meta: { target },
  });

const args = { entityId: 10, type: CollectionType.Model, userId: 42 };

beforeEach(() => {
  vi.clearAllMocks();
  // default: bookmark collection exists, no item yet
  mockDb.collection.findFirst.mockResolvedValue({ id: 999 });
  mockDb.collection.create.mockResolvedValue({ id: 999 });
  mockDb.collectionItem.findFirst.mockResolvedValue(null);
  mockDb.collectionItem.createMany.mockResolvedValue({ count: 1 });
  mockDb.collectionItem.deleteMany.mockResolvedValue({ count: 1 });
});

describe('toggleBookmarked — race #3: delete path is idempotent (deleteMany, no P2025)', () => {
  it('uses deleteMany (not delete) when un-bookmarking', async () => {
    mockDb.collectionItem.findFirst.mockResolvedValueOnce({ id: 555 });

    const result = await toggleBookmarked(args);

    expect(result).toBe(false); // existed → now removed
    expect(mockDb.collectionItem.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockDb.collectionItem.deleteMany).toHaveBeenCalledWith({ where: { id: 555 } });
    expect(mockDb.collectionItem.delete).not.toHaveBeenCalled();
    expect(queueUpdate).toHaveBeenCalledWith(10);
  });

  it('does NOT throw when the row is already gone (concurrent un-bookmark, count: 0)', async () => {
    mockDb.collectionItem.findFirst.mockResolvedValueOnce({ id: 555 });
    mockDb.collectionItem.deleteMany.mockResolvedValueOnce({ count: 0 });

    await expect(toggleBookmarked(args)).resolves.toBe(false);
    // metrics side-effect still runs on the idempotent delete path
    expect(queueUpdate).toHaveBeenCalledWith(10);
  });
});

describe('toggleBookmarked — race #2: create path uses createMany({ skipDuplicates: true })', () => {
  it('uses createMany with skipDuplicates (not create) when bookmarking', async () => {
    const result = await toggleBookmarked(args);

    expect(result).toBe(true); // did not exist → now added
    expect(mockDb.collectionItem.createMany).toHaveBeenCalledTimes(1);
    expect(mockDb.collectionItem.createMany).toHaveBeenCalledWith({
      data: [{ collectionId: 999, modelId: 10 }],
      skipDuplicates: true,
    });
    expect(mockDb.collectionItem.create).not.toHaveBeenCalled();
  });
});

describe('toggleBookmarked — race #1: collection.create P2002 is caught and re-fetched', () => {
  it('lost create race → re-fetches the bookmark collection and proceeds with its id', async () => {
    // no collection on first read → enter the create branch
    mockDb.collection.findFirst.mockResolvedValueOnce(null);
    // create loses the race
    mockDb.collection.create.mockRejectedValueOnce(p2002(['userId', 'type', 'mode']));
    // re-fetch returns the winner's collection
    mockDb.collection.findFirst.mockResolvedValueOnce({ id: 777 });

    const result = await toggleBookmarked(args);

    expect(result).toBe(true);
    // item op proceeds against the RE-FETCHED collection id (777), not undefined → no NPE
    expect(mockDb.collectionItem.createMany).toHaveBeenCalledWith({
      data: [{ collectionId: 777, modelId: 10 }],
      skipDuplicates: true,
    });
  });

  it('happy path: no collection → creates it once, no re-fetch needed', async () => {
    mockDb.collection.findFirst.mockResolvedValueOnce(null);
    mockDb.collection.create.mockResolvedValueOnce({ id: 888 });

    const result = await toggleBookmarked(args);

    expect(result).toBe(true);
    expect(mockDb.collection.create).toHaveBeenCalledTimes(1);
    expect(mockDb.collectionItem.createMany).toHaveBeenCalledWith({
      data: [{ collectionId: 888, modelId: 10 }],
      skipDuplicates: true,
    });
  });

  it('rethrows a non-P2002 collection.create error (does not swallow real failures)', async () => {
    mockDb.collection.findFirst.mockResolvedValueOnce(null);
    mockDb.collection.create.mockRejectedValueOnce(new Error('connection reset'));

    await expect(toggleBookmarked(args)).rejects.toThrow('connection reset');
  });

  it('throws a clear error if the collection is still missing after the create race', async () => {
    mockDb.collection.findFirst.mockResolvedValueOnce(null); // first read
    mockDb.collection.create.mockRejectedValueOnce(p2002(['userId', 'type', 'mode']));
    mockDb.collection.findFirst.mockResolvedValueOnce(null); // re-fetch also empty

    await expect(toggleBookmarked(args)).rejects.toThrow(
      'bookmark collection missing after create race'
    );
  });
});
