import { createJob } from './job';
import type { JobContext } from './job';
import { logToAxiom } from '~/server/logging/client';
import {
  expirePlacements,
  sweepUnpaidLegs,
  sweepUnplannedSettlements,
} from '~/server/services/placement-escrow.service';
import { sweepUncountedPlacements } from '~/server/services/placement-metrics.service';
import { sweepDeletedRemixGallerySubmissions } from '~/server/services/remix-gallery-sweep.service';

const BATCH = 100;

/**
 * A run drains a backlog rather than clearing one batch per tick, but never
 * unboundedly: a sweep whose rows do not leave its result set — Redis down, so
 * every leg declines its lock and nothing advances — would otherwise spin for
 * the whole lock expiration. Hitting the cap is reported, because a run that
 * stopped early is otherwise indistinguishable from one with nothing left.
 */
const MAX_BATCHES = 10;

async function drain<T>(
  name: string,
  jobContext: JobContext,
  run: () => Promise<T>,
  seen: (result: T) => number
) {
  const runs: T[] = [];

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    jobContext.checkIfCanceled();
    const result = await run();
    runs.push(result);
    if (seen(result) < BATCH) return { runs, hitCap: false };
  }

  await logToAxiom({
    name: 'placement-jobs',
    type: 'warning',
    message: `${name} hit its batch cap with work remaining`,
    batches: MAX_BATCHES,
  }).catch(() => null);

  return { runs, hitCap: true };
}

const sum = <T>(runs: T[], pick: (run: T) => number) =>
  runs.reduce((carry, run) => carry + pick(run), 0);

/**
 * Escrow with no timeout is money frozen indefinitely — an owner who never
 * answers has done none of the work the decline fee pays for, so both holds
 * return in full. Nothing else releases a placement nobody actioned.
 */
export const expirePlacementsJob = createJob(
  'placement-expire',
  '*/10 * * * *',
  async (jobContext) => {
    const { runs, hitCap } = await drain(
      'placement-expire',
      jobContext,
      () => expirePlacements({ limit: BATCH }),
      (result) => result.considered
    );

    return {
      considered: sum(runs, (run) => run.considered),
      expired: sum(runs, (run) => run.expired),
      hitCap,
    };
  },
  { lockExpiration: 10 * 60 }
);

/**
 * Legs claimed in the ledger whose payment never landed. Every leg carries a
 * 30-minute backoff of its own, so a tighter cadence than this buys nothing — it
 * would find the same rows ineligible.
 */
export const sweepUnpaidPlacementLegsJob = createJob(
  'placement-sweep-unpaid-legs',
  '*/15 * * * *',
  async (jobContext) => {
    const { runs, hitCap } = await drain(
      'placement-sweep-unpaid-legs',
      jobContext,
      () => sweepUnpaidLegs({ limit: BATCH }),
      (result) => result.stranded
    );

    return {
      stranded: sum(runs, (run) => run.stranded),
      resumed: sum(runs, (run) => run.resumed),
      // Not summed: every run reports the same outstanding total, so adding them
      // would multiply one number by the batch count and read as a spike.
      exhausted: runs.at(-1)?.exhausted ?? 0,
      hitCap,
    };
  },
  { lockExpiration: 15 * 60 }
);

/**
 * Settlements that never got a payout plan. Writing the plan inside the settle
 * transaction makes this unreachable going forward, so this is a backstop for
 * rows predating that and the check that it stays unreachable.
 *
 * **One batch, deliberately — this must not drain.** Its rows leave the set only
 * by acquiring a plan, and a run that cannot pay them (Buzz down) would re-select
 * the same ones until the cap on every pass. There is nothing to gain: the sweep
 * is hourly and the population it serves is meant to be empty.
 */
export const sweepUnplannedPlacementSettlementsJob = createJob(
  'placement-sweep-unplanned-settlements',
  '20 * * * *',
  async () => sweepUnplannedSettlements({ limit: BATCH }),
  { lockExpiration: 15 * 60 }
);

/**
 * Gallery submissions whose image was deleted after it was sent. The ordinary
 * expiry reaches them eventually; this releases the escrow without making the
 * submitter wait out a window for a decision that can no longer be made.
 *
 * Drains, because a creator deleting a post takes every submission of every
 * image in it with them, so the population arrives in bursts rather than
 * steadily.
 *
 * **Drains on `released`, not on `considered`.** Rows leave this set only by
 * settling, and a failed settle is caught and stepped over — so draining on
 * what was *selected* re-selects the same rows every pass when settlement is
 * down, burning the whole cap without ever reaching row 101. Same trap the
 * unplanned-settlements sweep above refuses to drain at all for.
 */
export const sweepDeletedRemixGallerySubmissionsJob = createJob(
  'remix-gallery-sweep-deleted',
  '*/30 * * * *',
  async (jobContext) => {
    const { runs, hitCap } = await drain(
      'remix-gallery-sweep-deleted',
      jobContext,
      () => sweepDeletedRemixGallerySubmissions({ limit: BATCH }),
      (result) => result.released
    );

    return {
      considered: sum(runs, (run) => run.considered),
      released: sum(runs, (run) => run.released),
      hitCap,
    };
  },
  { lockExpiration: 10 * 60 }
);

/**
 * Approved placements whose Buzz never reached the target's counter.
 *
 * Drains on `counted`, not on `considered` — rows leave this set only by being
 * marked, and a run that cannot emit (ClickHouse down) would otherwise re-select
 * the same hundred every pass and burn the cap without reaching row 101. Same
 * trap the deleted-submission sweep documents beside it.
 *
 * `lockExpiration` is a ceiling on how long the lock is held, not a timeout: it
 * is *released* at that point with the run still going, and a second run would
 * then select the same unmarked rows and count them twice. Held wide here
 * because the emit now waits for delivery, so a slow-but-healthy tracker
 * stretches a run that a failing one would cut short. A dead pod is still
 * recovered by the short refresh TTL lapsing, which this does not affect.
 */
export const sweepUncountedPlacementsJob = createJob(
  'placement-sweep-uncounted',
  '*/5 * * * *',
  async (jobContext) => {
    const { runs, hitCap } = await drain(
      'placement-sweep-uncounted',
      jobContext,
      () => sweepUncountedPlacements({ limit: BATCH }),
      (result) => result.counted
    );

    return {
      considered: sum(runs, (run) => run.considered),
      counted: sum(runs, (run) => run.counted),
      amount: sum(runs, (run) => run.amount),
      hitCap,
    };
  },
  { lockExpiration: 30 * 60 }
);

export const placementJobs = [
  expirePlacementsJob,
  sweepUnpaidPlacementLegsJob,
  sweepUnplannedPlacementSettlementsJob,
  sweepDeletedRemixGallerySubmissionsJob,
  sweepUncountedPlacementsJob,
];
