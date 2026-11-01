import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MeiliUtil from '~/server/meilisearch/util';

// `reset` is the one path that reaches Meilisearch for its own sake rather than through a
// processor's `pushData`: it creates the swap index, discards it, promotes it, and clears the
// update queue. All four are stubbed, because whether they were CALLED is the assertion.
const swapIndex = vi.fn();
const deleteSwapIndex = vi.fn();
const getOrCreateIndex = vi.fn();
const clearQueue = vi.fn();
/**
 * How many documents an index holds. `reset` reads this twice and the two reads mean different
 * things, so cases set it per index name: the SWAP index (is there a stale rebuild to refuse?) and
 * the LIVE index (is there anything for an empty rebuild to destroy?). Default 0 for both, which is
 * the "nothing at stake" baseline every other case wants.
 */
const documentCounts = new Map<string, number | null>();
const countIndexDocuments = vi.fn(async ({ indexName }: { indexName: string }) =>
  documentCounts.has(indexName) ? documentCounts.get(indexName)! : 0
);

vi.mock('~/server/meilisearch/util', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliUtil>()),
  getOrCreateIndex,
  swapIndex,
  deleteSwapIndex,
  countIndexDocuments,
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
  // `mockClear`, not `mockReset`: this one carries an implementation that reads `documentCounts`,
  // and `mockReset` would strip it, so every later case would see `undefined` document counts.
  // Clearing the call log is still required — without it the counts accumulate across cases and a
  // `not.toHaveBeenCalled()` assertion fails on calls another case made.
  countIndexDocuments.mockClear();
  documentCounts.clear();
});

/** The swap index a non-partial reset builds into, named once so the assertions agree. */
const SWAP_INDEX = 'test_index_NEW';

/**
 * Resolves to the error `reset` refused with, failing loudly if it resolved instead.
 *
 * It RE-THROWS anything that is not a refusal, which is the difference between this and a bare
 * `.catch`. A helper that hands back any rejection lets a case assert against, say, a `TypeError`
 * from a typo in the production path and still pass — measured: with `refuse` made to throw a
 * `TypeError`, one case in this file went green on a crash. Tightened here rather than in each
 * case, so the property holds for every current and future user.
 */
const expectRefusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('reset resolved; expected it to refuse the swap');
    },
    (e: unknown) => {
      if (!(e instanceof SearchIndexResetIncompleteError)) throw e;
      return e;
    }
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

  it.each([
    // The boundary is what the single-size case could not see: with only `remaining = 8` tested,
    // both `remaining >= 0` (always appends "…and 0 more") and `remaining > 1` (silently withholds
    // exactly one range) survive. AT the limit there must be no suffix; one past it there must be.
    { batches: FAILED_RANGE_MESSAGE_LIMIT, expectedWithheld: 0 },
    { batches: FAILED_RANGE_MESSAGE_LIMIT + 1, expectedWithheld: 1 },
    { batches: FAILED_RANGE_MESSAGE_LIMIT + 8, expectedWithheld: 8 },
  ])(
    'names at most FAILED_RANGE_MESSAGE_LIMIT of $batches ranges, and all of them on the field',
    async ({ batches, expectedWithheld }) => {
      // Every batch failing is the backend-down shape. Unbounded, the joined list is ~25 KB for a
      // real corpus and rides into the log sink inside the stack; the full list stays on the error.
      const index = buildIndex({
        prepareBatches: async () => ({ batchSize: 10, startId: 0, endId: batches * 10 }),
        pullData: vi.fn().mockRejectedValue(statementTimeout()),
      });

      const error = await expectRefusal(index.reset(jobContext));

      expect(error.totalTasks).toBe(batches);
      expect(error.failedTasks).toBe(batches);
      // The field is complete...
      expect(error.failedRanges).toHaveLength(batches);
      // ...the message is capped, and the number of rendered ranges never exceeds the limit.
      expect(error.message.match(/\d+-\d+/g) ?? []).toHaveLength(
        Math.min(batches, FAILED_RANGE_MESSAGE_LIMIT)
      );
      if (expectedWithheld === 0) {
        // AT the limit nothing was withheld, so there must be no suffix at all.
        expect(error.message).not.toContain('more');
      } else {
        expect(error.message).toContain(`…and ${expectedWithheld} more`);
      }
    },
    180_000
  );

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

  it('names the right index in every lifecycle call, and clears the queue only AFTER the swap', async () => {
    // Each of these is a wrong-ARGUMENT or wrong-ORDER mutation that the assertions above cannot
    // see, because they only check that a call happened:
    //  - `setup` against the live index reconfigures the SERVING index instead of the rebuild;
    //  - `getOrCreateIndex` against the swap index never ensures the base index a swap requires;
    //  - `clearQueue` before `swapIndex` wipes the repair channel while the promotion can still
    //    fail — the permanent half of the original incident, by a third route.
    const order: string[] = [];
    const setup = vi.fn(async () => void order.push('setup'));
    getOrCreateIndex.mockImplementation(async () => void order.push('getOrCreateIndex'));
    swapIndex.mockImplementation(async () => void order.push('swapIndex'));
    clearQueue.mockImplementation(async () => void order.push('clearQueue'));
    const index = buildIndex({ setup, pushData: async () => void order.push('push') });

    await index.reset(jobContext);

    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledWith({ indexName: SWAP_INDEX });
    // Compare the index NAME positionally rather than with `toHaveBeenCalledWith`:
    // `expect.anything()` does not match `undefined`, and the fixture passes no client, so a
    // whole-argument matcher fails for a reason that has nothing to do with the claim.
    const ensuredIndexNames = getOrCreateIndex.mock.calls.map((call) => call[0]);
    expect(ensuredIndexNames).toContain('test_index');
    expect(ensuredIndexNames).not.toContain(SWAP_INDEX);
    // The base index is ensured, then the rebuild is configured, then documents land, then the
    // promotion, and only then the queue.
    expect(order.indexOf('getOrCreateIndex')).toBeLessThan(order.indexOf('setup'));
    expect(order.indexOf('setup')).toBeLessThan(order.indexOf('push'));
    expect(order.indexOf('push')).toBeLessThan(order.indexOf('swapIndex'));
    expect(order.indexOf('swapIndex')).toBeLessThan(order.indexOf('clearQueue'));
    // `indexOf` returns -1 for an absent entry, which would satisfy a `toBeLessThan` by absence,
    // so pin presence separately.
    expect(order).toContain('swapIndex');
    expect(order).toContain('clearQueue');
  }, 60_000);

  it('still promotes a corpus that fits in a SINGLE batch, over a POPULATED index', async () => {
    // `tasks < 1` -> `tasks <= 1` survives every other case in this file, because no other fixture
    // produces exactly one batch. A one-batch corpus is the normal state of the smaller indexes, so
    // that mutant would refuse every reset of them.
    //
    // 🔴 The populated live index is load-bearing, and the first version of this case lacked it and
    // let the mutant live. With an EMPTY live index the off-by-one mutant reaches the no-batches
    // branch, finds nothing at stake, falls through and swaps anyway — indistinguishable from
    // correct. Only an index with documents to lose makes the wrong boundary refuse.
    documentCounts.set('test_index', 250);
    const pushData = vi.fn().mockResolvedValue(undefined);
    const index = buildIndex({
      prepareBatches: async () => ({ batchSize: 1000, startId: 0, endId: 500 }),
      pushData,
    });

    const result = await index.reset(jobContext);

    expect(result.totalTasks).toBe(1);
    expect(result.swapped).toBe(true);
    expect(pushData).toHaveBeenCalledTimes(1);
    expect(swapIndex).toHaveBeenCalledTimes(1);
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
  // without this it swapped a freshly-created EMPTY index over a populated one and then cleared the
  // update queue — this file's own harm, at its maximum, by a different route.
  //
  // Both shapes come from `prepareBatches`: six processors derive their bounds from
  // `MIN(id)/MAX(id)` and two from `ORDER BY "createdAt" LIMIT 1` subqueries, and all of them
  // return `null` on an empty eligible set.
  const NO_BATCH_SHAPES = [
    {
      label: 'an empty eligible corpus (null bounds)',
      // The `startId = 0` destructuring default does NOT fire for null, and `null - null` is 0.
      batches: { batchSize: BATCH_SIZE, startId: null, endId: null },
      expectedTotalTasks: 0,
    },
    {
      // NOT "a corpus of one row is empty" — it is not. This yields 0 batches because of a
      // pre-existing off-by-one: `tasks` is `ceil((endId - startId) / batchSize)` while each batch
      // closes at `min(start + batchSize - 1, endId)`, so equal bounds produce no batch at all.
      // Pinned as a route to `tasks === 0`, not as a statement about empty corpora. If that
      // arithmetic is ever fixed, this row is expected to fail and should be deleted.
      label: 'equal bounds (startId === endId), via the batch-count off-by-one',
      batches: { batchSize: BATCH_SIZE, startId: 500, endId: 500 },
      expectedTotalTasks: 0,
    },
    {
      // 🔴 The ONLY row that reaches the `!Number.isFinite(tasks)` half of the guard:
      // `Math.ceil(0 / 0)` is `NaN`, and `NaN < 1` is FALSE, so without that clause a NaN batch
      // count falls through both gates, the enqueue loop runs zero times, and an empty rebuild is
      // promoted. `{ batchSize: 0, startId: 0, endId: 0 }` is not invented — it is the literal
      // shape `metrics-images--update-metrics` returns when it has no ClickHouse client.
      label: 'a NaN batch count (batchSize 0)',
      batches: { batchSize: 0, startId: 0, endId: 0 },
      // `Math.ceil(0 / 0)` is NaN, but `totalTasks` reports the CLAMPED count — the number of
      // batches actually enqueued — so a non-finite value never escapes into a job result line.
      expectedTotalTasks: 0,
    },
  ];

  /**
   * Cast on the FUNCTION, not its result: the declared return type says `startId: number`, while
   * the real implementations return whatever the query gave them — `null` on an empty table.
   * Reproducing that is the point, so the cast models production rather than dodging the type.
   */
  const withBatches = (batches: unknown) =>
    ({ prepareBatches: async () => batches } as unknown as Partial<Processor>);

  it.each(NO_BATCH_SHAPES)(
    'refuses rather than replacing a populated index with nothing, for $label',
    async ({ batches }) => {
      // The live index HAS documents, so an empty rebuild would destroy them.
      documentCounts.set('test_index', 4321);
      const pushData = vi.fn();
      const index = buildIndex({ ...withBatches(batches), pushData });

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

  it.each(NO_BATCH_SHAPES)(
    'still swaps for $label when the live index is EMPTY, so a new index gets its settings',
    async ({ batches, expectedTotalTasks }) => {
      // The positive control for this guard, and not a nicety: `setup` runs only against the swap
      // index, so being swapped in is the ONLY way a brand-new index ever receives its settings.
      // Refusing here would strand it unconfigured forever and every filtered query would error.
      // That is the state of an index before launch, and of every index on a dev database.
      // `documentCounts` is left empty, i.e. 0 documents live.
      const setup = vi.fn();
      const index = buildIndex({ ...withBatches(batches), setup });

      const result = await index.reset(jobContext);

      expect(result).toEqual({
        indexName: 'test_index',
        totalTasks: expectedTotalTasks,
        failedTasks: 0,
        failedRanges: [],
        swapped: true,
      });
      expect(setup).toHaveBeenCalledWith({ indexName: SWAP_INDEX });
      expect(swapIndex).toHaveBeenCalledTimes(1);
      expect(clearQueue).toHaveBeenCalledTimes(1);
    },
    60_000
  );

  it('refuses when the live document count is unknown only if it is positive, never on null', async () => {
    // `countIndexDocuments` returns null when there is no search client. Nothing reaches the index
    // at all in that case, so nothing can be destroyed and the run must not fail.
    documentCounts.set('test_index', null);
    const index = buildIndex(withBatches(NO_BATCH_SHAPES[0].batches));

    await expect(index.reset(jobContext)).resolves.toMatchObject({ swapped: true });
  }, 60_000);
});

describe('reset :: a non-finite batch count cannot spin the enqueue loop', () => {
  it('treats an Infinity batch count as zero batches rather than looping forever', async () => {
    // `Math.ceil(n / 0)` with unequal bounds is `Infinity`. The refusal below it is conditional on
    // something being at stake, so an empty live index does NOT refuse — which means the loop bound
    // is the only thing standing between this and a hang. A test that hung would simply time out
    // after 60s, so the real assertion is that this returns at all.
    const pushData = vi.fn();
    const index = buildIndex({
      prepareBatches: async () => ({ batchSize: 0, startId: 0, endId: 70 }),
      pushData,
    });

    const result = await index.reset(jobContext);

    expect(result.totalTasks).toBe(0);
    expect(pushData).not.toHaveBeenCalled();
    // Live index is empty, so nothing is at stake and the empty rebuild is promoted — which is what
    // gives a brand-new index its settings.
    expect(result.swapped).toBe(true);
  }, 60_000);

  it('refuses an Infinity batch count when the live index has documents', async () => {
    documentCounts.set('test_index', 99);
    const index = buildIndex({
      prepareBatches: async () => ({ batchSize: 0, startId: 0, endId: 70 }),
    });

    const error = await expectRefusal(index.reset(jobContext));

    expect(error.reason).toBe('no-batches');
    expect(swapIndex).not.toHaveBeenCalled();
  }, 60_000);
});

describe('reset :: a rebuild must start from an empty swap index', () => {
  it('refuses when the swap index already holds documents', async () => {
    // `setup` does not clear the swap index and `pushData` upserts by primary key, so documents
    // left by an earlier run survive a rebuild that does not rewrite those ids — and the swap would
    // then promote rows that are no longer eligible.
    documentCounts.set(SWAP_INDEX, 17);
    const pushData = vi.fn();
    const index = buildIndex({ pushData });

    const error = await expectRefusal(index.reset(jobContext));

    expect(error.reason).toBe('stale-swap-index');
    expect(error.message).toContain('already held documents');
    expect(swapIndex).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
    // 🔴 And it refuses BEFORE rebuilding: pushing first would be hours of work thrown away, and
    // would also be the thing that makes the stale documents unrecoverable.
    expect(pushData).not.toHaveBeenCalled();
  }, 60_000);

  it('proceeds when the swap index is empty', async () => {
    // Positive control: without it, a guard that refused on every swap-index state would pass the
    // case above and break every reset.
    const index = buildIndex();

    const result = await index.reset(jobContext);

    expect(result.swapped).toBe(true);
    expect(countIndexDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ indexName: SWAP_INDEX })
    );
    expect(swapIndex).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('reads the swap index rather than deleting it before the rebuild', async () => {
    // 🔴 The ordering trap this design exists to avoid. Every Meilisearch mutation is a TASK, and
    // `deleteIndex` resolves when the deletion is ENQUEUED. A delete here would land AFTER `setup`
    // had read the OLD settings and found nothing to change, so no settings task would be
    // enqueued; the deletion would then remove the index, `updateDocuments` would auto-create a
    // bare one, and the swap would promote an index with NO attributes configured at all.
    const index = buildIndex();

    await index.reset(jobContext);

    // No delete on a clean run at all: `swapIndex` disposes of the swap index as its own last step.
    expect(deleteSwapIndex).not.toHaveBeenCalled();
  }, 60_000);
});

describe('reset :: discards the rebuild it refuses to promote', () => {
  it('deletes the SWAP index — never the live one — after refusing', async () => {
    // 🔴 The argument is the assertion. A mutant passing `indexName` here deletes the PRODUCTION
    // index on every refusal, which is strictly worse than the truncation this whole change
    // prevents: not a short corpus, an absent one. A call-count assertion cannot see that.
    const pullData = pullDataFailingSomeBatches();
    const index = buildIndex({ pullData });

    await expectRefusal(index.reset(jobContext));

    expect(deleteSwapIndex).toHaveBeenCalledTimes(1);
    expect(deleteSwapIndex).toHaveBeenCalledWith(
      expect.objectContaining({ swapIndexName: SWAP_INDEX })
    );
    // Stated as its own assertion so the intent survives a refactor of the matcher above.
    expect(deleteSwapIndex).not.toHaveBeenCalledWith(
      expect.objectContaining({ swapIndexName: 'test_index' })
    );
    expect(swapIndex).not.toHaveBeenCalled();
  }, 60_000);

  it("does NOT discard on a stale-swap-index refusal — that index is not this run's to delete", async () => {
    // 🔴 The one reason that must not clean up, and it is a safety property rather than a nicety.
    // Two resets of one index can overlap: a pod that dies drops its lock within seconds, and the
    // scheduler retries. If run B deleted the index it found populated, it would be deleting the
    // index run A is actively writing into — A's remaining pushes would then auto-create a bare
    // index and A would swap THAT in. Both failures this whole change prevents, caused by the guard
    // meant to prevent them.
    //
    // It is also what the check's own rationale demands: a populated swap index holds state this
    // run did not create, and deleting it is strictly more destructive than the clearing that
    // rationale already rejects as "a destructive act taken on a guess".
    documentCounts.set(SWAP_INDEX, 3);
    const index = buildIndex();

    const error = await expectRefusal(index.reset(jobContext));

    expect(error.reason).toBe('stale-swap-index');
    expect(deleteSwapIndex).not.toHaveBeenCalled();
    expect(swapIndex).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
  }, 60_000);

  it('still refuses, with its own error, when discarding the rebuild throws', async () => {
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
    // The code's comment says the cleanup failure is reported rather than swallowed, so hold it to
    // that. `beforeEach` stubs `console.error`, which is exactly what would otherwise make this
    // claim unobservable.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`could not discard ${SWAP_INDEX}`),
      expect.anything()
    );
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
    expect(countIndexDocuments).not.toHaveBeenCalled();
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
    // And it must not acquire the swap-index lifecycle: there is no swap index on this path, so
    // neither the stale-swap read nor the discard may run.
    expect(deleteSwapIndex).not.toHaveBeenCalled();
    expect(countIndexDocuments).not.toHaveBeenCalled();
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
    expect(countIndexDocuments).not.toHaveBeenCalled();
  }, 60_000);
});
