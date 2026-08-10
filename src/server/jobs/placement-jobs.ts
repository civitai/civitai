import { createJob } from './job';
import type { JobContext } from './job';
import { logToAxiom } from '~/server/logging/client';
import {
  expirePlacements,
  sweepUnpaidLegs,
  sweepUnplannedSettlements,
} from '~/server/services/placement-escrow.service';

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

export const placementJobs = [
  expirePlacementsJob,
  sweepUnpaidPlacementLegsJob,
  sweepUnplannedPlacementSettlementsJob,
];
