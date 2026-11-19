import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newReviewBatchId, reviewBatchHash } from '@civitai/shared/review-batch';

/**
 * Where the moderator app reads a review batch: the cache cluster, and system Redis only as the
 * fallback for batches a main app released before the move still writes there. Two stores, so a
 * read from the wrong one shows.
 */

const { cluster, sys } = vi.hoisted(() => ({
  cluster: new Map<string, string>(),
  sys: new Map<string, string>(),
}));

vi.mock('../redis', () => ({
  getRedis: () => ({ get: async (key: string) => cluster.get(key) ?? null }),
  getSysRedis: () => ({ get: async (key: string) => sys.get(key) ?? null }),
}));
vi.mock('../db', () => ({ dbWrite: {} }));
vi.mock('../clickhouse', () => ({ getClickhouse: () => undefined }));

const { getReviewBatch, REVIEW_BATCH_SYS_FALLBACK_UNTIL } = await import('../review-batch');

const record = (keyId: number) =>
  JSON.stringify({
    ids: [1],
    tier: 'general',
    declared: false,
    viewer: 8,
    createdBy: 7,
    keyId,
    seat: null,
    createdAt: 1,
  });

beforeEach(() => {
  cluster.clear();
  sys.clear();
});

describe('reading a review batch', () => {
  it('reads a batch the cache cluster holds', async () => {
    const id = newReviewBatchId();
    cluster.set(`app:review-batch:${reviewBatchHash(id)}`, record(1));
    expect((await getReviewBatch(id))?.keyId).toBe(1);
  });

  it('🔴 opens a batch only system Redis holds, written by a main app released before the move', async () => {
    const id = newReviewBatchId();
    sys.set(`app:review-batch:${reviewBatchHash(id)}`, record(2));
    expect((await getReviewBatch(id))?.keyId).toBe(2);
  });

  it('prefers the cluster copy, and answers null when neither store holds the batch', async () => {
    const id = newReviewBatchId();
    cluster.set(`app:review-batch:${reviewBatchHash(id)}`, record(3));
    sys.set(`app:review-batch:${reviewBatchHash(id)}`, record(4));
    expect((await getReviewBatch(id))?.keyId).toBe(3);
    expect(await getReviewBatch(newReviewBatchId())).toBeNull();
  });

  it('pins the end of the system Redis fallback', () => {
    expect(REVIEW_BATCH_SYS_FALLBACK_UNTIL.toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });
});
