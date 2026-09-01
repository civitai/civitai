import { createJob } from './job';
import type { JobContext } from './job';
import { logToAxiom } from '~/server/logging/client';
import {
  expirePlacements,
  sweepUnpaidLegs,
  sweepUnplannedSettlements,
} from '~/server/services/placement-escrow.service';
import {
  countAbandonedPlacements,
  sweepUncountedPlacements,
} from '~/server/services/placement-metrics.service';
import { sweepDeletedRemixGallerySubmissions } from '~/server/services/remix-gallery-sweep.service';
import { startReadyRemixSubmissionClocks } from '~/server/services/remix-gallery.service';

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
/**
 * Submissions paid for before their image was finished, resolved once it is.
 *
 * Runs more often than the expiry sweep because it is the thing standing between
 * a published image and the owner ever seeing the submission: until this runs the
 * row is invisible to them, and its deadline is still counting down the
 * submitter's drafting window rather than the owner's answering one.
 */
export const startReadyRemixSubmissionClocksJob = createJob(
  'remix-gallery-readiness',
  '*/5 * * * *',
  async (jobContext) => {
    const { runs, hitCap } = await drain(
      'remix-gallery-readiness',
      jobContext,
      () => startReadyRemixSubmissionClocks({ limit: BATCH }),
      // Drains on rows that LEFT the set, not on rows that were selected — the
      // same rule `sweepDeletedRemixGallerySubmissionsJob` below states. A row
      // leaves only by having its clock started or its escrow settled; a failed
      // settle is caught and stepped over, and a review-blocked row is marked
      // and stepped over. Draining on `considered` re-reads the identical
      // lowest-100 ids on all ten passes whenever settlement is down, burning
      // the cap without ever reaching row 101.
      (result) => result.started + result.refunded
    );

    return {
      considered: sum(runs, (run) => run.considered),
      started: sum(runs, (run) => run.started),
      refunded: sum(runs, (run) => run.refunded),
      hitCap,
    };
  },
  { lockExpiration: 10 * 60 }
);

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
 * counted, and a run that cannot emit (ClickHouse down) would otherwise re-claim
 * the same hundred every pass and burn the cap without reaching row 101.
 *
 * `emitted` is shared across the whole drain because the sweep's collision
 * guarantee is per page: two pages of one (image, placer) would emit twice
 * within the same second and the pipeline would keep one. The second page's
 * group is left for the next tick instead, which is what `deferred` counts.
 *
 * A run that claimed work and counted none of it is reported — that reads
 * identically to a quiet run otherwise — but a run that only *deferred* is not,
 * because deferring is this design working.
 */
export const sweepUncountedPlacementsJob = createJob(
  'placement-sweep-uncounted',
  '*/5 * * * *',
  async (jobContext) => {
    const emitted = new Set<string>();
    const { runs, hitCap } = await drain(
      'placement-sweep-uncounted',
      jobContext,
      () => sweepUncountedPlacements({ limit: BATCH, alreadyEmitted: emitted }),
      (result) => result.counted
    );

    const considered = sum(runs, (run) => run.considered);
    const counted = sum(runs, (run) => run.counted);
    const deferred = sum(runs, (run) => run.deferred);
    const undelivered = sum(runs, (run) => run.undelivered);

    // A collision defer is the design working and must not alarm — it is this
    // sweep's own intended path, and an alarm that fires there stops being read.
    // An UNDELIVERED defer is the opposite: the sweep could not emit at all, so
    // it counts toward the alarm rather than excusing it.
    if (considered > deferred && counted === 0)
      await logToAxiom({
        name: 'placement-jobs',
        type: 'warning',
        message: 'placement-sweep-uncounted claimed work and counted none of it',
        considered,
        undelivered,
      }).catch(() => null);

    return {
      considered,
      counted,
      amount: sum(runs, (run) => run.amount),
      deferred,
      undelivered,
      // Rows the sweep has given up on. Past the attempt ceiling they are never
      // selected again, so this is the only thing that says the counter is short
      // and by how much.
      //
      // Read only when it could have changed. `metricAttempts` is not in the
      // sweep's index, so this is a scan of it — cheap on the queue it is sized
      // for, and pointless to pay every five minutes to be told zero.
      abandoned: counted === 0 && considered > deferred ? await countAbandonedPlacements() : null,
      // The flag is off, so nothing was even looked at. Distinct from a run that
      // found nothing to do.
      skipped: runs.every((run) => run.skipped),
      hitCap,
    };
  },
  { lockExpiration: 30 * 60 }
);

export const placementJobs = [
  expirePlacementsJob,
  startReadyRemixSubmissionClocksJob,
  sweepUnpaidPlacementLegsJob,
  sweepUnplannedPlacementSettlementsJob,
  sweepDeletedRemixGallerySubmissionsJob,
  sweepUncountedPlacementsJob,
];
