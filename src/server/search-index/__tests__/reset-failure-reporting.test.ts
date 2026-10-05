import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MeiliUtil from '~/server/meilisearch/util';

// `reset` is the one path that reaches Meilisearch for its own sake rather than through a
// processor's `pushData`: it creates the swap index, discards it, promotes it, and clears the
// update queue. All four are stubbed, because whether they were CALLED is the assertion.
const swapIndex = vi.fn();
const deleteSwapIndex = vi.fn();
const getOrCreateIndex = vi.fn();
const clearQueue = vi.fn();

vi.mock('~/server/meilisearch/util', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliUtil>()),
  getOrCreateIndex,
  swapIndex,
  deleteSwapIndex,
  onSearchIndexDocumentsCleanup: vi.fn(),
}));

vi.mock('~/server/search-index/SearchIndexUpdate', () => ({
  SearchIndexUpdate: { clearQueue, queueUpdate: vi.fn(), getQueue: vi.fn() },
}));

const {
  createSearchIndexUpdateProcessor,
  SearchIndexResetIncompleteError,
  FAILED_RANGE_MESSAGE_LIMIT,
} = await import('~/server/search-index/base.search-index');

type Processor = Parameters<typeof createSearchIndexUpdateProcessor>[0];

/**
 * The corpus every case in this file resets, chosen so that no two quantities coincide.
 *
 * 70 ids at 10 per batch is 7 batches: [0-9] [10-19] [20-29] [30-39] [40-49] [50-59] [60-69].
 * 7 (batches) is not 10 (batch size) and not 70 (the id span), so an assertion on the batch
 * count cannot be satisfied by a mutant that reports either of the others.
 */
const START_ID = 0;
const END_ID = 70;
const BATCH_SIZE = 10;
const TOTAL_BATCHES = 7;

/**
 * The batches made to fail, by the first id of each. TWO of seven, and deliberately neither the
 * first nor the last pair: a count of 2 is not the total (7), not the batch size (10), not the id
 * span (70), and not `failedTasks * BATCH_SIZE` (20). Their ranges are literal below.
 */
const FAILING_BATCH_START_IDS = [10, 40];
const EXPECTED_FAILED_RANGES = [
  { startId: 10, endId: 19 },
  { startId: 40, endId: 49 },
];
const EXPECTED_FAILED_TASK_COUNT = 2;

/** What a Prisma statement-timeout surfaces as inside `pullData` — the production trigger. */
const statementTimeout = () =>
  Object.assign(new Error('canceling statement due to statement timeout'), { code: 'P2010' });

const jobContext = {
  status: 'running' as const,
  on: () => undefined,
  checkIfCanceled: () => undefined,
};

/**
 * A processor whose range pulls return one document per id, so a clean reset pushes documents and
 * a failing one is distinguishable from an empty one.
 */
const buildIndex = (overrides: Partial<Processor> = {}) =>
  createSearchIndexUpdateProcessor({
    indexName: 'test_index',
    setup: async () => undefined,
    prepareBatches: async () => ({ batchSize: BATCH_SIZE, startId: START_ID, endId: END_ID }),
    pullData: async (_ctx, batch) =>
      batch.type === 'new'
        ? Array.from({ length: batch.endId - batch.startId + 1 }, (_, i) => ({
            id: batch.startId + i,
          }))
        : batch.ids.map((id) => ({ id })),
    transformData: async (data: unknown) => data,
    pushData: async () => undefined,
    ...overrides,
  });

/** `pullData` that throws for the batches named in `FAILING_BATCH_START_IDS` and pulls the rest. */
const pullDataFailingSomeBatches = () =>
  vi.fn(async (_ctx: unknown, batch: { type: string; startId?: number; endId?: number }) => {
    if (batch.type !== 'new') return [];
    if (FAILING_BATCH_START_IDS.includes(batch.startId as number)) throw statementTimeout();
    return Array.from(
      { length: (batch.endId as number) - (batch.startId as number) + 1 },
      (_, i) => ({
        id: (batch.startId as number) + i,
      })
    );
  });

const byStartId = (a: { startId: number }, b: { startId: number }) => a.startId - b.startId;

beforeEach(() => {
  // processSearchIndexTask logs every caught error; keep the run readable.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  swapIndex.mockReset();
  deleteSwapIndex.mockReset();
  getOrCreateIndex.mockReset();
  clearQueue.mockReset();
});

/** The swap index a non-partial reset builds into, named once so the assertions agree. */
const SWAP_INDEX = 'test_index_NEW';

/** Resolves to the error `reset` refused with, failing loudly if it resolved instead. */
const expectRefusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('reset resolved; expected it to refuse the swap');
    },
    (e: unknown) => e as InstanceType<typeof SearchIndexResetIncompleteError>
  );

describe('reset :: refuses to publish a truncated index', () => {
  it('does not swap, and does not clear the update queue, when a batch permanently failed', async () => {
    // THE regression case. Before the fix, `Promise.all(workers)` resolved on a run that had
    // dropped batches exactly as on a clean one, and the swap + clearQueue ran unconditionally:
    // a truncated corpus was published and the channel that would have repaired it was wiped.
    const pullData = pullDataFailingSomeBatches();
    const index = buildIndex({ pullData });

    await expect(index.reset(jobContext)).rejects.toThrow(SearchIndexResetIncompleteError);

    // The two assertions that are the actual guarantee: the index that was serving still is.
    expect(swapIndex).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
  }, 60_000);

  it('names the batches and the id ranges that were lost', async () => {
    const pullData = pullDataFailingSomeBatches();
    const index = buildIndex({ pullData });

    const error = await expectRefusal(index.reset(jobContext));

    // Literal values from the fixture above, not derived from the implementation.
    expect(error.failedTasks).toBe(EXPECTED_FAILED_TASK_COUNT);
    expect(error.totalTasks).toBe(TOTAL_BATCHES);
    expect(error.indexName).toBe('test_index');
    // Worker scheduling decides the order tasks give up in, so compare as a set by start id.
    expect([...error.failedRanges].sort(byStartId)).toEqual(EXPECTED_FAILED_RANGES);
    // A partial failure, not a total one — strictly fewer than every batch.
    expect(error.failedTasks).toBeLessThan(error.totalTasks);
    // The message is the operator's repair instruction, so pin that the ranges reach it.
    expect(error.message).toContain('10-19');
    expect(error.message).toContain('40-49');
    expect(error.message).toContain('2 of 7 batches failed');
  }, 60_000);

  it('still writes the batches that succeeded into the unpromoted index', async () => {
    // The refusal must not be achieved by abandoning the run early: the 5 surviving batches are
    // pushed, into `${SWAP_INDEX}`, which is then simply not promoted.
    const pullData = pullDataFailingSomeBatches();
    const pushedTo: string[] = [];
    const pushData = vi.fn(async (ctx: { indexName: string }) => {
      pushedTo.push(ctx.indexName);
    });
    const index = buildIndex({ pullData, pushData });

    await expect(index.reset(jobContext)).rejects.toThrow(SearchIndexResetIncompleteError);

    expect(pushData).toHaveBeenCalledTimes(TOTAL_BATCHES - EXPECTED_FAILED_TASK_COUNT);
    expect(new Set(pushedTo)).toEqual(new Set([SWAP_INDEX]));
    expect(swapIndex).not.toHaveBeenCalled();
  }, 60_000);

  it('attributes a failure at the PUSH step back to the range the batch came from', async () => {
    // The pull step is where every other case here fails, and a pull task carries its own range.
    // A push task does not: the range has to survive the pull -> transform -> push handoff, the
    // same way the id count does. Failing at the push step is what pins that — with the handoff
    // dropped, this reports the right COUNT and an empty range list, which is a report an
    // operator cannot act on.
    const pushData = vi.fn(async (_ctx: unknown, data: { id: number }[]) => {
      if (data.some((d) => d.id === 50)) throw new Error('meilisearch rejected the batch');
    });
    const index = buildIndex({ pushData });

    const error = await expectRefusal(index.reset(jobContext));

    expect(error.failedTasks).toBe(1);
    expect(error.failedRanges).toEqual([{ startId: 50, endId: 59 }]);
    expect(error.message).toContain('50-59');
    expect(swapIndex).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
  }, 60_000);

  it('attributes a failure at a LATER PULL STEP back to the range the batch came from', async () => {
    // A multi-step pull re-queues ITSELF between steps, rebuilt as `{...t, currentData,
    // currentStep}` — a third handoff, distinct from pull->transform and transform->push, where
    // the range survives only because of the object spread. `users`, `images` and the
    // image-metrics index all set `pullSteps`, and a statement timeout at step >= 1 is exactly the
    // production shape, so without a case here that handoff is untested.
    const PULL_STEPS = 3;
    const pullData = vi.fn(
      async (_ctx: unknown, batch: { type: string; startId?: number }, step?: number) => {
        if (batch.type !== 'new') return [];
        if (batch.startId === 30 && step === 1) throw statementTimeout();
        return [{ id: batch.startId }];
      }
    );
    const index = buildIndex({ pullData, pullSteps: PULL_STEPS });

    const error = await expectRefusal(index.reset(jobContext));

    expect(error.failedTasks).toBe(1);
    expect(error.failedRanges).toEqual([{ startId: 30, endId: 39 }]);
    expect(error.message).toContain('30-39');
    expect(swapIndex).not.toHaveBeenCalled();
  }, 60_000);

  it('names at most FAILED_RANGE_MESSAGE_LIMIT ranges in the message, and all of them on the field', async () => {
    // Every batch failing is the backend-down shape. Unbounded, the joined list is ~25 KB for a
    // real corpus and rides into the log sink inside the stack; the full list stays queryable on
    // the error. 28 batches is deliberately more than the limit of 20 and not a multiple of it.
    const BATCHES = 28;
    const index = buildIndex({
      prepareBatches: async () => ({ batchSize: 10, startId: 0, endId: BATCHES * 10 }),
      pullData: vi.fn().mockRejectedValue(statementTimeout()),
    });

    const error = await expectRefusal(index.reset(jobContext));

    expect(error.totalTasks).toBe(BATCHES);
    expect(error.failedTasks).toBe(BATCHES);
    // The field is complete...
    expect(error.failedRanges).toHaveLength(BATCHES);
    // ...the message is capped, and says how many it withheld.
    expect(error.message).toContain(`…and ${BATCHES - FAILED_RANGE_MESSAGE_LIMIT} more`);
    expect(error.message.match(/\d+-\d+/g) ?? []).toHaveLength(FAILED_RANGE_MESSAGE_LIMIT);
  }, 120_000);

  it('reports a single failed batch as one, not as every batch', async () => {
    // A second, differently-sized failure so the count cannot be a hardcoded 2 and still pass.
    const pullData = vi.fn(async (_ctx: unknown, batch: { type: string; startId?: number }) => {
      if (batch.type !== 'new') return [];
      if (batch.startId === 30) throw statementTimeout();
      return [{ id: batch.startId }];
    });
    const index = buildIndex({ pullData });

    const error = await expectRefusal(index.reset(jobContext));

    expect(error.failedTasks).toBe(1);
    expect(error.totalTasks).toBe(TOTAL_BATCHES);
    expect(error.failedRanges).toEqual([{ startId: 30, endId: 39 }]);
    expect(swapIndex).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
  }, 60_000);
});

describe('reset :: positive control — a clean run still publishes', () => {
  it('swaps the rebuilt index in and clears the update queue when every batch succeeded', async () => {
    // Without this, a fix that refuses EVERY swap passes every case above and breaks all resets.
    const pushData = vi.fn().mockResolvedValue(undefined);
    const index = buildIndex({ pushData });

    const result = await index.reset(jobContext);

    expect(result).toEqual({
      indexName: 'test_index',
      totalTasks: TOTAL_BATCHES,
      failedTasks: 0,
      failedRanges: [],
      swapped: true,
    });
    expect(swapIndex).toHaveBeenCalledTimes(1);
    expect(swapIndex).toHaveBeenCalledWith(
      expect.objectContaining({ indexName: 'test_index', swapIndexName: SWAP_INDEX })
    );
    expect(clearQueue).toHaveBeenCalledTimes(1);
    expect(clearQueue).toHaveBeenCalledWith('test_index');
    expect(pushData).toHaveBeenCalledTimes(TOTAL_BATCHES);
  }, 60_000);

  it('swaps even when a batch failed once and then succeeded on retry', async () => {
    // A retried-then-successful batch is NOT a dropped batch. `failTask` only records a task that
    // exhausted its retries, so the guard must not fire here — otherwise one transient timeout
    // would block every reset.
    let attempts = 0;
    const pullData = vi.fn(
      async (_ctx: unknown, batch: { type: string; startId?: number; endId?: number }) => {
        if (batch.type !== 'new') return [];
        if (batch.startId === 20 && attempts++ === 0) throw statementTimeout();
        return [{ id: batch.startId }];
      }
    );
    const index = buildIndex({ pullData });

    const result = await index.reset(jobContext);

    expect(result.failedTasks).toBe(0);
    expect(result.swapped).toBe(true);
    expect(swapIndex).toHaveBeenCalledTimes(1);
    // 7 batches + the one retry.
    expect(pullData).toHaveBeenCalledTimes(TOTAL_BATCHES + 1);
  }, 60_000);
});

describe('reset :: refuses a rebuild that has no batches at all', () => {
  // The dropped-batch gate is satisfied by a run that enqueued NOTHING: `failedTasks === 0`, so
  // before this guard it swapped a freshly-created EMPTY index over a populated one and then
  // cleared the update queue — this file's own harm, at its maximum, by a different route.
  //
  // Both shapes come straight from `prepareBatches`, which is `SELECT MIN(id), MAX(id)` in every
  // processor here with no null guard.
  it.each([
    {
      label: 'an empty eligible corpus (null bounds)',
      // `startId = 0` destructuring default does NOT fire for null, and `null - null` is 0.
      batches: { batchSize: BATCH_SIZE, startId: null, endId: null },
    },
    {
      label: 'a single eligible row (startId === endId)',
      batches: { batchSize: BATCH_SIZE, startId: 500, endId: 500 },
    },
  ])(
    'refuses rather than swapping an empty index in for $label',
    async ({ batches }) => {
      const pushData = vi.fn();
      const index = buildIndex({
        // Cast on the FUNCTION, not its result: the declared return type says
        // `startId: number`, while the real `prepareBatches` implementations return whatever
        // `SELECT MIN(id), MAX(id)` gave them — `null` on an empty table. Reproducing that is the
        // point of this case, so the cast is modelling production, not dodging the type.
        prepareBatches: (async () => batches) as unknown as Processor['prepareBatches'],
        pushData,
      });

      const error = await expectRefusal(index.reset(jobContext));

      expect(error.reason).toBe('no-batches');
      expect(error.totalTasks).toBe(0);
      expect(error.message).toContain('enqueued 0 batches');
      // Nothing was pulled or pushed, so the rebuild is empty — and it stays unpromoted.
      expect(pushData).not.toHaveBeenCalled();
      expect(swapIndex).not.toHaveBeenCalled();
      expect(clearQueue).not.toHaveBeenCalled();
    },
    60_000
  );
});

describe('reset :: the rebuild starts and ends without a stale swap index', () => {
  it('discards the swap index before rebuilding, so a push cannot land on stale documents', async () => {
    // `setup` does not clear the swap index and `pushData` upserts by primary key, so documents
    // left by an earlier abandoned rebuild would survive a run that simply does not rewrite those
    // ids — and the swap would promote rows that are no longer eligible.
    const order: string[] = [];
    deleteSwapIndex.mockImplementation(async () => void order.push('delete'));
    const index = buildIndex({
      setup: async () => void order.push('setup'),
      pushData: async () => void order.push('push'),
    });

    await index.reset(jobContext);

    expect(deleteSwapIndex).toHaveBeenCalledWith(
      expect.objectContaining({ swapIndexName: SWAP_INDEX })
    );
    // Order is the whole point: a discard after `setup`, or after the first push, would delete the
    // rebuild instead of the leftovers.
    expect(order[0]).toBe('delete');
    expect(order[1]).toBe('setup');
    expect(order.indexOf('delete')).toBeLessThan(order.indexOf('push'));
  }, 60_000);

  it('discards the unpromoted swap index when it refuses', async () => {
    // Otherwise a near-complete copy of the corpus sits resident until the next run.
    const pullData = pullDataFailingSomeBatches();
    const index = buildIndex({ pullData });

    await expectRefusal(index.reset(jobContext));

    // Twice: once before the rebuild, once after refusing to promote it.
    expect(deleteSwapIndex).toHaveBeenCalledTimes(2);
    expect(swapIndex).not.toHaveBeenCalled();
  }, 60_000);

  it('still refuses, with its own error, when discarding the swap index throws', async () => {
    // A cleanup failure must not replace the diagnosis with something less informative.
    const pullData = pullDataFailingSomeBatches();
    deleteSwapIndex.mockRejectedValue(new Error('meilisearch rejected deleteIndex'));
    const index = buildIndex({ pullData });

    const error = await expectRefusal(index.reset(jobContext));

    expect(error).toBeInstanceOf(SearchIndexResetIncompleteError);
    expect(error.reason).toBe('dropped-batches');
    expect(error.failedTasks).toBe(EXPECTED_FAILED_TASK_COUNT);
    expect(swapIndex).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
  }, 60_000);

  it('does not delete the swap index on a clean run, because the swap already does', async () => {
    const index = buildIndex();

    const result = await index.reset(jobContext);

    expect(result.swapped).toBe(true);
    // Only the pre-rebuild discard; `swapIndex` deletes it as its own last step.
    expect(deleteSwapIndex).toHaveBeenCalledTimes(1);
  }, 60_000);
});

describe('reset :: a retired index does nothing', () => {
  it('returns an unswapped result without touching the index', async () => {
    // This early return changed shape in the same change (`void` -> a result), and deleting the
    // guard entirely would rebuild and SWAP a retired index and clear its queue.
    const pushData = vi.fn();
    const index = buildIndex({ retired: true, pushData });

    const result = await index.reset(jobContext);

    expect(result).toEqual({
      indexName: 'test_index',
      totalTasks: 0,
      failedTasks: 0,
      failedRanges: [],
      swapped: false,
    });
    expect(pushData).not.toHaveBeenCalled();
    expect(getOrCreateIndex).not.toHaveBeenCalled();
    expect(swapIndex).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
    expect(deleteSwapIndex).not.toHaveBeenCalled();
  }, 60_000);
});

describe('reset :: partial mode is unchanged', () => {
  // `partial: true` writes in place into the live index. It has no swap counterpart to refuse and
  // never clears the update queue, so the outcome the refusals exist to prevent cannot happen on
  // that path. (It is NOT "the every-minute job" — every `*-reset` job is registered at
  // `UNRUNNABLE_JOB_CRON`; the every-minute job for that processor is `update`.)
  it('resolves rather than throwing when a partial reset drops a batch', async () => {
    const pullData = pullDataFailingSomeBatches();
    const index = buildIndex({ partial: true, pullData });

    const result = await index.reset(jobContext);

    expect(result.failedTasks).toBe(EXPECTED_FAILED_TASK_COUNT);
    expect(result.swapped).toBe(false);
    // Range tasks are enqueued BEFORE the partial branch, so a partial reset does carry ranges.
    // The result type's comment used to claim this was always empty; nothing asserted it.
    expect([...result.failedRanges].sort(byStartId)).toEqual(EXPECTED_FAILED_RANGES);
    // None of these was called BEFORE the change either — a partial reset never reached them.
    expect(swapIndex).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
    // And it must not acquire the swap-index lifecycle: there is no swap index on this path.
    expect(deleteSwapIndex).not.toHaveBeenCalled();
  }, 60_000);

  it('writes a partial reset into the live index, not a swap index', async () => {
    const pushedTo: string[] = [];
    const pushData = vi.fn(async (ctx: { indexName: string }) => {
      pushedTo.push(ctx.indexName);
    });
    const index = buildIndex({ partial: true, pushData });

    const result = await index.reset(jobContext);

    expect(result.swapped).toBe(false);
    expect(result.failedTasks).toBe(0);
    expect(result.failedRanges).toEqual([]);
    expect(new Set(pushedTo)).toEqual(new Set(['test_index']));
    expect(swapIndex).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
    expect(deleteSwapIndex).not.toHaveBeenCalled();
  }, 60_000);
});
