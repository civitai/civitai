import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `drain` counts, for the remix-gallery readiness pass.
 *
 * 🔴 This exists because `placement-jobs.ts` had no test at all, and the thing it
 * pins is a one-word difference that no other test in the repo can see: the
 * predicate reads rows that LEFT the set, not rows that were SELECTED.
 *
 * The two sibling sweeps in the same file already state the rule in prose — a row
 * leaves the readiness set only by having its clock started or its escrow
 * settled, and a failed settle is caught and stepped over. So when settlement is
 * degraded, `considered` stays at the batch size while nothing moves, and all ten
 * drain passes re-read the identical lowest-100 ids by `ORDER BY pl.id ASC`,
 * burning the cap without ever reaching row 101.
 *
 * The fake returns a fixed object and the loop is bounded by `MAX_BATCHES` in the
 * module under test, so a revert fails by ASSERTION on a call count — it cannot
 * hang, which is the failure mode a test runner cannot report.
 */
const startReadyRemixSubmissionClocks = vi.fn();
vi.mock('~/server/services/remix-gallery.service', () => ({
  startReadyRemixSubmissionClocks,
}));

vi.mock('~/server/services/placement-escrow.service', () => ({
  expirePlacements: vi.fn(async () => ({ expired: 0 })),
  sweepUnpaidLegs: vi.fn(async () => ({ swept: 0 })),
  sweepUnplannedSettlements: vi.fn(async () => ({ swept: 0 })),
}));

vi.mock('~/server/services/placement-metrics.service', () => ({
  countAbandonedPlacements: vi.fn(async () => ({ counted: 0 })),
  sweepUncountedPlacements: vi.fn(async () => ({ counted: 0 })),
}));

vi.mock('~/server/services/remix-gallery-sweep.service', () => ({
  sweepDeletedRemixGallerySubmissions: vi.fn(async () => ({ considered: 0, released: 0 })),
}));

const { startReadyRemixSubmissionClocksJob } = await import('~/server/jobs/placement-jobs');

/** The module's own `BATCH`. A batch that comes back short ends the drain. */
const BATCH = 100;
/** The module's own `MAX_BATCHES`, i.e. what an unbounded drain costs. */
const MAX_BATCHES = 10;

/**
 * `createJob().run()` is NOT async — it returns `{ result, cancel }` and the job
 * keeps going on its own. Awaiting the call itself resolves after two microtask
 * turns, so the drain has run twice and every count is wrong while the test still
 * looks like it waited. Await the `result` promise.
 */
const runJob = async () => {
  const { result } = startReadyRemixSubmissionClocksJob.run({});
  return result;
};

describe('the readiness job drains on rows that left the set', () => {
  beforeEach(() => {
    startReadyRemixSubmissionClocks.mockReset();
  });

  it('stops after one pass when a full batch produced no movement', async () => {
    // Settlement is down: every row was selected, none was acted on. Draining on
    // `considered` re-reads the same ids MAX_BATCHES times and never advances.
    startReadyRemixSubmissionClocks.mockResolvedValue({
      considered: BATCH,
      started: 0,
      refunded: 0,
      marked: 0,
    });

    await expect(runJob()).resolves.toMatchObject({ hitCap: false });

    expect(
      startReadyRemixSubmissionClocks,
      'a batch where nothing left the set must not be re-read'
    ).toHaveBeenCalledTimes(1);
  });

  it('keeps draining while a full batch is actually clearing', async () => {
    // The property the drain exists for, so the fix above cannot be "return 0".
    startReadyRemixSubmissionClocks
      .mockResolvedValueOnce({ considered: BATCH, started: BATCH, refunded: 0, marked: 0 })
      .mockResolvedValueOnce({ considered: BATCH, started: BATCH - 1, refunded: 1, marked: 0 })
      .mockResolvedValue({ considered: 3, started: 3, refunded: 0, marked: 0 });

    await runJob();

    expect(startReadyRemixSubmissionClocks).toHaveBeenCalledTimes(3);
  });

  /**
   * 🔴 The third way out, and the one a fix round got wrong. A `needsReview` row
   * is neither started nor refunded — it is MARKED undeliverable, and the
   * selection SQL then excludes it. Counting only the first two stops the drain
   * after one batch whenever any row took that branch, which the service's own
   * measurement calls the common outcome for those rows. Rows 101+ are reachable
   * and never reached.
   */
  it('keeps draining when a full batch left the set by being marked', async () => {
    startReadyRemixSubmissionClocks
      .mockResolvedValueOnce({ considered: BATCH, started: 0, refunded: 0, marked: BATCH })
      .mockResolvedValue({ considered: 2, started: 0, refunded: 0, marked: 2 });

    await runJob();

    expect(
      startReadyRemixSubmissionClocks,
      'a batch cleared entirely by marking must not end the drain'
    ).toHaveBeenCalledTimes(2);
  });

  it('never exceeds the batch cap even if every pass stays full', async () => {
    startReadyRemixSubmissionClocks.mockResolvedValue({
      considered: BATCH,
      started: BATCH,
      refunded: 0,
      marked: 0,
    });

    // `hitCap` too: the cap's only operator-visible signal is that flag and the
    // warning beside it, and both are separately deletable from the call count.
    await expect(runJob()).resolves.toMatchObject({ hitCap: true });

    expect(startReadyRemixSubmissionClocks).toHaveBeenCalledTimes(MAX_BATCHES);
  });
});
