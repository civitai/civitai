import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock } from '~/__tests__/mocks';
import type * as JobModule from '~/server/jobs/job';
import type * as MeiliUtil from '~/server/meilisearch/util';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

vi.mock('~/server/meilisearch/util', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliUtil>()),
  onSearchIndexDocumentsCleanup: vi.fn(),
}));
vi.mock('~/server/jobs/job', async (importOriginal) => ({
  ...(await importOriginal<typeof JobModule>()),
  getJobDate: async () => [new Date(0), async () => undefined] as const,
}));

const { createSearchIndexUpdateProcessor } = await import(
  '~/server/search-index/base.search-index'
);
const { checkoutQueue } = await import('~/server/redis/queues');

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
 * `queues.ts` run: whether a re-parked id survives `commit()` is a property of how the two
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
const seedUpdateQueue = async (ids: number[]) => {
  const { REDIS_SYS_KEYS } = await import('~/server/redis/client');
  store.hashes.set(hashField(REDIS_SYS_KEYS.QUEUES.BUCKETS, UPDATE_KEY), SEED_BUCKET);
  store.sets.set(SEED_BUCKET, new Set(ids.map(String)));
};

const remainingQueuedIds = async () =>
  (await checkoutQueue(UPDATE_KEY, false, true)).content.sort((a, b) => a - b);

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
    await seedUpdateQueue(QUEUED_IDS);

    await buildIndex().update({} as never);

    expect(pushed.sort((a, b) => a - b)).toEqual([101, 102, 103, 107, 108, 109]);
    expect(await remainingQueuedIds()).toEqual(FAILING_BATCH);
  }, 30_000);

  it('processQueues() leaves the failed batch on the queue for the next run', async () => {
    // processQueues batches by 10,000 rather than by `batchSize`, so all nine ids share the
    // poisoned batch here.
    await seedUpdateQueue(QUEUED_IDS);

    await buildIndex().processQueues({ processUpdates: true }, {} as never);

    expect(pushed).toEqual([]);
    expect(await remainingQueuedIds()).toEqual(QUEUED_IDS);
  }, 30_000);

  it('re-queues ids whose push failed, not only ids whose transform failed', async () => {
    await seedUpdateQueue(QUEUED_IDS);
    const index = buildIndex({
      transformData: async (docs: unknown) => docs,
      pushData: async (_ctx: unknown, docs: { id: number }[]) => {
        if (docs.some((d) => d.id === POISON_ID)) throw new Error('push rejected');
        pushed.push(...docs.map((d) => d.id));
      },
    });

    await index.update({} as never);

    expect(await remainingQueuedIds()).toEqual(FAILING_BATCH);
  }, 30_000);

  it('re-queues ids whose pull failed', async () => {
    await seedUpdateQueue(QUEUED_IDS);
    const index = buildIndex({
      pullData: async (_ctx: unknown, batch: { type: string; ids?: number[] }) => {
        if (batch.ids?.includes(POISON_ID)) throw new Error('canceling statement');
        return batch.ids?.map((id) => ({ id })) ?? null;
      },
    });

    await index.update({} as never);

    expect(await remainingQueuedIds()).toEqual(FAILING_BATCH);
  }, 30_000);

  it('survives a checkout whose bucket-list write was dropped', async () => {
    // If the checkout could not register its fresh bucket, the queue's newest bucket is still the
    // one being drained — so an id re-queued BEFORE commit() lands in a bucket commit() deletes.
    await seedUpdateQueue(QUEUED_IDS);
    const { REDIS_SYS_KEYS } = await import('~/server/redis/client');
    let checkoutWrites = 0;
    const realHSet = redisMock.sysRedis.hSet.getMockImplementation();
    redisMock.sysRedis.hSet.mockImplementation(
      async (hash: string, field: string, value: string) => {
        if (
          hash === REDIS_SYS_KEYS.QUEUES.BUCKETS &&
          field === UPDATE_KEY &&
          checkoutWrites++ === 0
        )
          throw new Error('sysRedis write timed out');
        return realHSet?.(hash, field, value);
      }
    );

    await buildIndex().update({} as never);

    expect(await remainingQueuedIds()).toEqual(FAILING_BATCH);
  }, 30_000);

  it('parks the ids in Postgres and says so when Redis refuses the re-queue', async () => {
    await seedUpdateQueue(QUEUED_IDS);
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
  }, 30_000);

  it('does not re-queue for a partial index, whose checkout never removed the ids', async () => {
    // Invariant guard, not a regression test: a read-only checkout loses nothing on `main` either.
    await seedUpdateQueue(QUEUED_IDS);

    await buildIndex({ partial: true }).update({} as never);

    expect(redisMock.sysRedis.sAdd).not.toHaveBeenCalled();
    expect(await remainingQueuedIds()).toEqual(QUEUED_IDS);
  }, 30_000);
});
