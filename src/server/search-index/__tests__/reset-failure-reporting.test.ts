import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MeiliUtil from '~/server/meilisearch/util';

// `reset` is the one path that reaches Meilisearch for its own sake rather than through a
// processor's `pushData`: it creates the swap index, promotes it, and clears the Redis-backed
// update queue. All three are stubbed, because whether they were CALLED is the assertion.
const swapIndex = vi.fn();
const getOrCreateIndex = vi.fn();
const clearQueue = vi.fn();

vi.mock('~/server/meilisearch/util', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliUtil>()),
  getOrCreateIndex,
  swapIndex,
  onSearchIndexDocumentsCleanup: vi.fn(),
}));

vi.mock('~/server/search-index/SearchIndexUpdate', () => ({
  SearchIndexUpdate: { clearQueue, queueUpdate: vi.fn(), getQueue: vi.fn() },
}));

const { createSearchIndexUpdateProcessor, SearchIndexResetIncompleteError } = await import(
  '~/server/search-index/base.search-index'
);

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
  getOrCreateIndex.mockReset();
  clearQueue.mockReset();
});

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

    const error = await index.reset(jobContext).then(
      () => {
        throw new Error('reset resolved; expected it to refuse the swap');
      },
      (e: unknown) => e as InstanceType<typeof SearchIndexResetIncompleteError>
    );

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
    // pushed, into `test_index_NEW`, which is then simply not promoted.
    const pullData = pullDataFailingSomeBatches();
    const pushedTo: string[] = [];
    const pushData = vi.fn(async (ctx: { indexName: string }) => {
      pushedTo.push(ctx.indexName);
    });
    const index = buildIndex({ pullData, pushData });

    await expect(index.reset(jobContext)).rejects.toThrow(SearchIndexResetIncompleteError);

    expect(pushData).toHaveBeenCalledTimes(TOTAL_BATCHES - EXPECTED_FAILED_TASK_COUNT);
    expect(new Set(pushedTo)).toEqual(new Set(['test_index_NEW']));
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

    const error = await index.reset(jobContext).then(
      () => {
        throw new Error('reset resolved; expected it to refuse the swap');
      },
      (e: unknown) => e as InstanceType<typeof SearchIndexResetIncompleteError>
    );

    expect(error.failedTasks).toBe(1);
    expect(error.failedRanges).toEqual([{ startId: 50, endId: 59 }]);
    expect(error.message).toContain('50-59');
    expect(swapIndex).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
  }, 60_000);

  it('reports a single failed batch as one, not as every batch', async () => {
    // A second, differently-sized failure so the count cannot be a hardcoded 2 and still pass.
    const pullData = vi.fn(async (_ctx: unknown, batch: { type: string; startId?: number }) => {
      if (batch.type !== 'new') return [];
      if (batch.startId === 30) throw statementTimeout();
      return [{ id: batch.startId }];
    });
    const index = buildIndex({ pullData });

    const error = await index.reset(jobContext).then(
      () => {
        throw new Error('reset resolved; expected it to refuse the swap');
      },
      (e: unknown) => e as InstanceType<typeof SearchIndexResetIncompleteError>
    );

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
      expect.objectContaining({ indexName: 'test_index', swapIndexName: 'test_index_NEW' })
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

describe('reset :: partial mode is unchanged', () => {
  // `partial: true` writes in place into the live index. It has no swap counterpart to refuse and
  // never clears the update queue, so the truncation this guard exists to prevent cannot happen
  // on that path — and it is the every-minute metrics job, which must not start throwing.
  it('resolves rather than throwing when a partial reset drops a batch', async () => {
    const pullData = pullDataFailingSomeBatches();
    const index = buildIndex({ partial: true, pullData });

    const result = await index.reset(jobContext);

    expect(result.failedTasks).toBe(EXPECTED_FAILED_TASK_COUNT);
    expect(result.swapped).toBe(false);
    // Neither was called BEFORE the change either — a partial reset never reached them.
    expect(swapIndex).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
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
    expect(new Set(pushedTo)).toEqual(new Set(['test_index']));
    expect(swapIndex).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
  }, 60_000);
});
