import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `drain` counts for the stale-unfunded continuation sweep: rows that LEFT
 * the set (settled), never rows that were selected. A row the sweep steps over
 * (its settle failed, or it was funded meanwhile) is selected again next pass,
 * so draining on `considered` would re-read the same lowest ids every pass.
 * See placement-jobs.drain.test.ts for the same rule on the remix pass.
 */
const settleStaleUnfundedContinuations = vi.fn();
const settleOrphanedContinuations = vi.fn();
vi.mock('~/server/services/storyline-placement.service', () => ({
  settleStaleUnfundedContinuations,
  settleOrphanedContinuations,
  startReadyStorylineContinuations: vi.fn(async () => ({ considered: 0, started: 0, refunded: 0 })),
}));
vi.mock('~/server/services/remix-gallery.service', () => ({
  startReadyRemixSubmissionClocks: vi.fn(async () => ({ considered: 0, started: 0, refunded: 0 })),
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

const { placementJobs, settleStaleUnfundedContinuationsJob, settleOrphanedContinuationsJob } =
  await import('~/server/jobs/placement-jobs');

/** The module's own `BATCH` and `MAX_BATCHES`. */
const BATCH = 100;
const MAX_BATCHES = 10;

/** `run()` returns `{ result }`; awaiting the call itself does not wait for the drain. */
const runJob = async () => settleStaleUnfundedContinuationsJob.run({}).result;

describe('the stale-unfunded continuation job', () => {
  beforeEach(() => settleStaleUnfundedContinuations.mockReset());

  it('is registered with the placement jobs', () => {
    expect(placementJobs).toContain(settleStaleUnfundedContinuationsJob);
  });

  it('stops after one pass when a full batch settled nothing', async () => {
    settleStaleUnfundedContinuations.mockResolvedValue({ considered: BATCH, settled: 0 });

    await expect(runJob()).resolves.toMatchObject({ considered: BATCH, settled: 0, hitCap: false });
    expect(settleStaleUnfundedContinuations).toHaveBeenCalledTimes(1);
  });

  it('keeps going while full batches are settled, and sums them', async () => {
    settleStaleUnfundedContinuations
      .mockResolvedValueOnce({ considered: BATCH, settled: BATCH })
      .mockResolvedValueOnce({ considered: 30, settled: 30 });

    await expect(runJob()).resolves.toEqual({
      considered: BATCH + 30,
      settled: BATCH + 30,
      hitCap: false,
    });
    expect(settleStaleUnfundedContinuations).toHaveBeenCalledTimes(2);
    expect(settleStaleUnfundedContinuations).toHaveBeenCalledWith({ limit: BATCH });
  });

  it('stops at the cap and says so', async () => {
    settleStaleUnfundedContinuations.mockResolvedValue({ considered: BATCH, settled: BATCH });

    await expect(runJob()).resolves.toMatchObject({ hitCap: true });
    expect(settleStaleUnfundedContinuations).toHaveBeenCalledTimes(MAX_BATCHES);
  });
});

// The same drain rule for continuations whose parent is no longer a live chapter:
// a row whose settle failed is selected again next pass.
describe('the orphaned continuation job', () => {
  const runOrphaned = async () => settleOrphanedContinuationsJob.run({}).result;
  beforeEach(() => settleOrphanedContinuations.mockReset());

  it('is registered with the placement jobs', () => {
    expect(placementJobs).toContain(settleOrphanedContinuationsJob);
  });

  it('stops after one pass when a full batch settled nothing', async () => {
    settleOrphanedContinuations.mockResolvedValue({ considered: BATCH, settled: 0 });

    await expect(runOrphaned()).resolves.toMatchObject({
      considered: BATCH,
      settled: 0,
      hitCap: false,
    });
    expect(settleOrphanedContinuations).toHaveBeenCalledTimes(1);
    expect(settleOrphanedContinuations).toHaveBeenCalledWith({ limit: BATCH });
  });

  it('keeps going while full batches are settled, up to the cap', async () => {
    settleOrphanedContinuations.mockResolvedValue({ considered: BATCH, settled: BATCH });

    await expect(runOrphaned()).resolves.toMatchObject({ hitCap: true });
    expect(settleOrphanedContinuations).toHaveBeenCalledTimes(MAX_BATCHES);
  });
});
