import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock } from '~/__tests__/mocks';
import type * as JobModule from '~/server/jobs/job';
import type * as MeiliUtil from '~/server/meilisearch/util';
import type * as ErrorHandling from '~/server/utils/errorHandling';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

vi.mock('~/server/meilisearch/util', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliUtil>()),
  onSearchIndexDocumentsCleanup: vi.fn(),
}));
vi.mock('~/server/jobs/job', async (importOriginal) => ({
  ...(await importOriginal<typeof JobModule>()),
  getJobDate: async () => [new Date(0), async () => undefined] as const,
}));
// The task queue's 1s retry backoff, cut to a macrotask so each failing batch does not cost 3s.
vi.mock('~/server/utils/errorHandling', async (importOriginal) => ({
  ...(await importOriginal<typeof ErrorHandling>()),
  sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
}));

const { createSearchIndexUpdateProcessor } = await import(
  '~/server/search-index/base.search-index'
);
const { checkoutQueue } = await import('~/server/redis/queues');
const { REDIS_SYS_KEYS } = await import('~/server/redis/client');

const INDEX = 'repark_test_index';
const UPDATE_KEY = `${INDEX}:${SearchIndexUpdateQueueAction.Update}`;
const SEED_BUCKET = 'seed-bucket';

// Three batches of three. The middle batch is the one whose transform keeps failing, the way the
// models index's per-batch owner lookup does when its statement is cut off server-side.
const QUEUED_IDS = [101, 102, 103, 104, 105, 106, 107, 108, 109];
const FAILING_BATCH = [104, 105, 106];
const POISON_ID = 104;

/**
 * An in-memory sysRedis behind the canonical mock, so the REAL `SearchIndexUpdate` and
 * `queues.ts` run: whether a re-queued id survives `commit()` is a property of how the two
 * interact on the bucket list, which a mocked `getQueue` cannot see.
 */
const store = { hashes: new Map<string, string>(), sets: new Map<string, Set<string>>() };
const hashField = (hash: unknown, field: unknown) => `${String(hash)}::${String(field)}`;

const installFakeSysRedis = () => {
  store.hashes.clear();
  store.sets.clear();
  const { sysRedis } = redisMock;
  sysRedis.hGet.mockImplementation(async (hash: string, field: string) =>
    store.hashes.has(hashField(hash, field)) ? store.hashes.get(hashField(hash, field)) : null
  );
  sysRedis.hSet.mockImplementation(async (hash: string, field: string, value: string) => {
    store.hashes.set(hashField(hash, field), value);
    return 1;
  });
  sysRedis.sAdd.mockImplementation(async (key: string, members: string[]) => {
    const set = store.sets.get(key) ?? new Set<string>();
    for (const m of [members].flat()) set.add(m);
    store.sets.set(key, set);
    return members.length;
  });
  sysRedis.sMembers.mockImplementation(async (key: string) => [...(store.sets.get(key) ?? [])]);
  sysRedis.del.mockImplementation(async (keys: string | string[]) => {
    for (const k of [keys].flat()) store.sets.delete(k);
    return 1;
  });
  sysRedis.exists.mockResolvedValue(0);
};

/** Queue the ids in a pre-existing bucket, as an earlier enqueue would have left them. */
const seedUpdateQueue = (ids: number[]) => {
  store.hashes.set(hashField(REDIS_SYS_KEYS.QUEUES.BUCKETS, UPDATE_KEY), SEED_BUCKET);
  store.sets.set(SEED_BUCKET, new Set(ids.map(String)));
};

const remainingQueuedIds = async () =>
  (await checkoutQueue(UPDATE_KEY, false, true)).content.sort((a, b) => a - b);

const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

let pushed: number[] = [];
const buildIndex = (overrides: Record<string, unknown> = {}) =>
  createSearchIndexUpdateProcessor({
    indexName: INDEX,
    setup: async () => undefined,
    // endId < startId: no range tasks, so every task is a targeted batch of queued ids.
    prepareBatches: async () => ({ batchSize: 3, startId: 1, endId: 0, updateIds: [] }),
    pullData: async (_ctx, batch) =>
      batch.type === 'update' ? batch.ids.map((id) => ({ id })) : null,
    transformData: async (docs: { id: number }[]) => {
      if (docs.some((d) => d.id === POISON_ID))
        throw new Error(
          'Invalid `prisma.user.findMany()` invocation: Server has closed the connection.'
        );
      return docs;
    },
    pushData: async (_ctx, docs: { id: number }[]) => {
      pushed.push(...docs.map((d) => d.id));
    },
    workerCount: 1,
    client: {} as never,
    ...overrides,
  });

beforeEach(() => {
  // The canonical mocks are reset per FILE, not per test; without this, call counts leak forward.
  vi.clearAllMocks();
  pushed = [];
  installFakeSysRedis();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('search index :: a batch that exhausts its retries is re-queued, not discarded', () => {
  it('update() leaves exactly the failed batch on the queue for the next run', async () => {
    seedUpdateQueue(QUEUED_IDS);

    await buildIndex().update({} as never);

    expect(sorted(pushed)).toEqual([101, 102, 103, 107, 108, 109]);
    expect(await remainingQueuedIds()).toEqual(FAILING_BATCH);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`re-queued ${FAILING_BATCH.length} ids`)
    );
  });

  it('processQueues() leaves exactly the failed batch on the queue for the next run', async () => {
    // processQueues batches by 10,000 regardless of `batchSize`, so the poison id goes in the
    // second batch to tell "re-queue the failed batch" from "re-queue everything".
    const firstBatch = Array.from({ length: 10_000 }, (_, i) => i + 1);
    const poison = 10_001;
    seedUpdateQueue([...firstBatch, poison]);
    const index = buildIndex({
      transformData: async (docs: { id: number }[]) => {
        if (docs.some((d) => d.id === poison)) throw new Error('Server has closed the connection.');
        return docs;
      },
    });

    await index.processQueues({ processUpdates: true }, {} as never);

    expect(sorted(pushed)).toEqual(firstBatch);
    expect(await remainingQueuedIds()).toEqual([poison]);
  });

  it('re-queues ids whose push failed, not only ids whose transform failed', async () => {
    seedUpdateQueue(QUEUED_IDS);
    const index = buildIndex({
      transformData: async (docs: unknown) => docs,
      pushData: async (_ctx: unknown, docs: { id: number }[]) => {
        if (docs.some((d) => d.id === POISON_ID)) throw new Error('push rejected');
        pushed.push(...docs.map((d) => d.id));
      },
    });

    await index.update({} as never);

    expect(await remainingQueuedIds()).toEqual(FAILING_BATCH);
  });

  it('re-queues ids whose pull failed', async () => {
    seedUpdateQueue(QUEUED_IDS);
    const index = buildIndex({
      pullData: async (_ctx: unknown, batch: { type: string; ids?: number[] }) => {
        if (batch.ids?.includes(POISON_ID)) throw new Error('canceling statement');
        return batch.ids?.map((id) => ({ id })) ?? null;
      },
    });

    await index.update({} as never);

    expect(await remainingQueuedIds()).toEqual(FAILING_BATCH);
  });

  it('re-queues failed ids that came from prepareBatches rather than the queue', async () => {
    // `setLastUpdate` moves the updatedAt window past these, so the queue is their only retry.
    const index = buildIndex({
      prepareBatches: async () => ({
        batchSize: 3,
        startId: 1,
        endId: 0,
        updateIds: [201, 202, 203, POISON_ID, 205, 206],
      }),
    });

    await index.update({} as never);

    expect(sorted(pushed)).toEqual([201, 202, 203]);
    expect(await remainingQueuedIds()).toEqual([POISON_ID, 205, 206]);
  });

  it('survives a checkout whose bucket-list write was dropped', async () => {
    // If the checkout could not register its fresh bucket, the queue's newest bucket is still the
    // one being drained — so an id re-queued BEFORE commit() lands in a bucket commit() deletes.
    seedUpdateQueue(QUEUED_IDS);
    let faultFired = false;
    const realHSet = redisMock.sysRedis.hSet.getMockImplementation();
    redisMock.sysRedis.hSet.mockImplementation(
      async (hash: string, field: string, value: string) => {
        if (hash === REDIS_SYS_KEYS.QUEUES.BUCKETS && field === UPDATE_KEY && !faultFired) {
          faultFired = true;
          throw new Error('sysRedis write timed out');
        }
        return realHSet?.(hash, field, value);
      }
    );

    await buildIndex().update({} as never);

    expect(faultFired).toBe(true);
    expect(await remainingQueuedIds()).toEqual(FAILING_BATCH);
  });

  it('parks the ids in Postgres and says so when Redis refuses the re-queue', async () => {
    seedUpdateQueue(QUEUED_IDS);
    // The run's only sAdd is the re-queue: the seed bypasses addToQueue.
    redisMock.sysRedis.sAdd.mockRejectedValue(new Error('sysRedis unavailable'));
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ capped: false }]);

    await buildIndex().update({} as never);

    const parkCall = dbMock.dbWrite.$queryRaw.mock.calls.find((call: unknown[]) =>
      (call[0] as string[]).join('?').includes('INSERT INTO "KeyValue"')
    );
    expect(parkCall?.slice(1, 3)).toEqual([
      `search-index-queue-fallback:${UPDATE_KEY}`,
      JSON.stringify(FAILING_BATCH),
    ]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`could not re-queue ${FAILING_BATCH.length} ids`)
    );
  });
});

describe('search index :: paths that must NOT re-queue', () => {
  // Invariant guards, not regression tests: each of these loses nothing on `main` either.
  it('a partial index, whose read-only checkout never removed the ids', async () => {
    seedUpdateQueue(QUEUED_IDS);

    await buildIndex({ partial: true }).update({} as never);

    expect(redisMock.sysRedis.sAdd).not.toHaveBeenCalled();
    expect(await remainingQueuedIds()).toEqual(QUEUED_IDS);
  });

  it('a processor that does not drain the Update queue', async () => {
    const transformData = vi.fn(async () => {
      throw new Error('Server has closed the connection.');
    });
    const index = buildIndex({
      queues: ['delete'],
      transformData,
      prepareBatches: async () => ({
        batchSize: 3,
        startId: 1,
        endId: 0,
        updateIds: [POISON_ID, 105, 106],
      }),
    });

    await index.update({} as never);

    // 1 attempt + 3 retries: the batch really did fail for good.
    expect(transformData).toHaveBeenCalledTimes(4);
    expect(redisMock.sysRedis.sAdd).not.toHaveBeenCalled();
  });

  it('a failed range task, which holds a span rather than ids', async () => {
    const pullData = vi.fn(async (_ctx: unknown, batch: { type: string }) => {
      if (batch.type === 'new') throw new Error('canceling statement');
      return null;
    });
    const index = buildIndex({
      prepareBatches: async () => ({ batchSize: 3, startId: 301, endId: 303, updateIds: [] }),
      pullData,
    });

    await index.update({} as never);

    expect(pullData).toHaveBeenCalledTimes(4);
    expect(redisMock.sysRedis.sAdd).not.toHaveBeenCalled();
  });
});
