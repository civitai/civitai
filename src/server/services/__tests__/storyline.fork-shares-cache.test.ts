import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { CacheTTL } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';

/**
 * A reader's choice shows in the very next shares read, through the real fork-count cache.
 *
 * The page reads children and shares in one batch and both refill the fork-count key, so a choice
 * writes the new counts through instead of marking the key stale: a read that loses the refill lock
 * would otherwise be served the count from before the choice. This test holds the lock for another
 * reader and reads straight after.
 */

const logSysRedisFailOpen = vi.hoisted(() => vi.fn());
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen }));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  getBlockedPairIds: vi.fn(async () => []),
  HiddenUsers: { getCached: vi.fn(async () => []) },
}));

import {
  getStorylineForkShares,
  recordStorylineBranchChoice,
} from '~/server/services/storyline.service';

const READER = 3;
const w = dbMock.dbWrite;
const r = dbMock.dbRead;

/** Redis as a map, so what one call writes the next one reads. */
let store: Map<string, unknown>;

const counts = (pairs: Array<[number, number]>) =>
  w.storylineBranchChoice.groupBy.mockResolvedValue(
    pairs.map(([chapterId, n]) => ({ chapterId, _count: { _all: n } })) as never
  );

beforeEach(() => {
  resetSharedMocks();
  logSysRedisFailOpen.mockReset();
  store = new Map();
  redisMock.redis.packed.get.mockImplementation(
    (async (key: string) => store.get(key) ?? null) as never
  );
  redisMock.redis.packed.set.mockImplementation((async (key: string, value: unknown) => {
    store.set(key, value);
  }) as never);
  // Another reader in the same batch holds the refill lock throughout.
  redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(false as never);
  redisMock.redis.del.mockResolvedValue(undefined as never);

  // Chapter 1 of storyline 10, PG, which this reader can see.
  w.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10 } as never);
  r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10 } as never);
  r.storyline.findUnique.mockResolvedValue({
    id: 10,
    userId: 1,
    title: 'A story',
    status: 'Ongoing',
    whoCanContinue: 'Anyone',
    maxNsfwLevel: NsfwLevel.R,
    tosViolation: false,
    createdAt: new Date('2026-10-01'),
    user: { id: 1, username: 'owner', bannedAt: null, deletedAt: null },
    chapters: [
      {
        id: 1,
        postId: 101,
        removedAt: null,
        post: {
          nsfwLevel: NsfwLevel.PG,
          publishedAt: new Date(0),
          tosViolation: false,
          user: { bannedAt: null, deletedAt: null },
        },
      },
    ],
  } as never);
  w.storylineChapterEdge.findUnique.mockResolvedValue({ chapterId: 12 } as never);
});

describe('fork shares straight after a choice', () => {
  it('count the choice even for a read that loses the refill lock', async () => {
    const read = { chapterId: 1, viewer: { id: READER }, browsingLevel: NsfwLevel.PG };
    // Before: one reader went to chapter 11, and that count is cached.
    counts([[11, 1]]);
    redisMock.redis.setNxKeepTtlWithEx.mockResolvedValueOnce(true as never);
    await expect(getStorylineForkShares(read)).resolves.toMatchObject({ counts: { 11: 1 } });

    // This reader takes chapter 12.
    counts([
      [11, 1],
      [12, 1],
    ]);
    await recordStorylineBranchChoice({
      viewer: { id: READER },
      browsingLevel: NsfwLevel.PG,
      fromChapterId: 1,
      toChapterId: 12,
    });

    // The very next read, with the lock held elsewhere, already counts it.
    await expect(getStorylineForkShares(read)).resolves.toMatchObject({
      total: 2,
      counts: { 11: 1, 12: 1 },
      shares: { 11: 0.5, 12: 0.5 },
    });
  });

  it('serve the next read from the written counts, without reading them again', async () => {
    counts([[12, 1]]);
    await recordStorylineBranchChoice({
      viewer: { id: READER },
      browsingLevel: NsfwLevel.PG,
      fromChapterId: 1,
      toChapterId: 12,
    });
    const readsAfterChoice = w.storylineBranchChoice.groupBy.mock.calls.length;
    // The lock is free: a stale entry would be refilled from the database here.
    redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true as never);
    await getStorylineForkShares({
      chapterId: 1,
      viewer: { id: READER },
      browsingLevel: NsfwLevel.PG,
    });
    expect(w.storylineBranchChoice.groupBy.mock.calls.length).toBe(readsAfterChoice);
  });

  const choose = () =>
    recordStorylineBranchChoice({
      viewer: { id: READER },
      browsingLevel: NsfwLevel.PG,
      fromChapterId: 1,
      toChapterId: 12,
    });

  it('write the counts for as long as a refill would keep them', async () => {
    counts([[12, 1]]);
    await choose();
    expect(redisMock.redis.packed.set).toHaveBeenCalledWith(
      'packed:caches:storyline-fork-counts:1',
      { data: [[12, 1]], cachedAt: expect.any(Number) },
      { EX: CacheTTL.sm * 2 },
      { compress: false, cacheName: undefined }
    );
  });

  it('keep the choice when the cache write fails, and say so', async () => {
    counts([[12, 1]]);
    redisMock.redis.packed.set.mockRejectedValue(new Error('cache cluster down') as never);
    await expect(choose()).resolves.toBeUndefined();
    expect(w.storylineBranchChoice.upsert).toHaveBeenCalledTimes(1);
    expect(logSysRedisFailOpen).toHaveBeenCalledWith(
      'write-degraded',
      'setFetchThroughCache set (cache cluster)',
      expect.any(Error),
      { key: 'packed:caches:storyline-fork-counts:1' }
    );
  });

  it('keep the choice when its counts cannot be read, and mark the cached ones stale', async () => {
    store.set('packed:caches:storyline-fork-counts:1', { data: [[11, 1]], cachedAt: Date.now() });
    w.storylineBranchChoice.groupBy.mockRejectedValue(new Error('primary unavailable') as never);
    await expect(choose()).resolves.toBeUndefined();
    expect(w.storylineBranchChoice.upsert).toHaveBeenCalledTimes(1);
    expect(store.get('packed:caches:storyline-fork-counts:1')).toEqual({
      data: [[11, 1]],
      cachedAt: 0,
    });
    // Swallowed, so it must be logged: a failure moved inside that catch would otherwise vanish.
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', chapterId: 1, error: 'primary unavailable' })
    );
  });
});
