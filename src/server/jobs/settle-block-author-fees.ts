import { createJob } from './job';
import { isAppBlocksAuthorFeeEnabled } from '~/server/services/app-blocks-flag';
import { settleBlockAuthorFees } from '~/server/services/blocks/author-fee-settlement.service';
import { createLogger } from '~/utils/logging';

const log = createLogger('block-author-fee-settlement', 'green');

/**
 * Daily settlement of App Blocks per-generation AUTHOR FEES.
 *
 * Pays each app owner the sum of the fees their viewers were debited since the
 * last run, one Buzz transaction per (owner × buzz type). The charge already
 * happened at submit; this is the second hop, mirroring
 * `deliver-creator-compensation` for the model licensing fee.
 *
 * 🔴 A NEWLY ADDED CRON IS NOT PICKED UP BY A DEPLOY. Jobs are discovered
 * through `/api/internal/get-jobs` and the external scheduler needs an explicit
 * refresh, so this will not be dispatched at all until someone performs that
 * out-of-band step. Nobody has scheduled it — and that is correct for now, since
 * the flag is off and there is nothing to settle. Do not read "merged" as "running".
 *
 * Scheduled at 02:30 UTC — thirty minutes after the creator-compensation job at
 * 02:00, deliberately. Both mint Buzz in batches through the same service, and
 * stacking them on the same minute would put two large batch calls in flight
 * together for no benefit; nothing about this job is time-sensitive to the
 * minute.
 *
 * 🔴 GATED ON THE FLAG, AND THAT IS NOT BELT-AND-BRACES. The accrual writer is
 * behind `app-blocks-author-fee-enabled` too, so with the flag off there is
 * nothing to settle and this gate is redundant *today*. It exists for the window
 * the flag creates: if the fee is turned ON, accrues rows, and is then turned
 * OFF again because something is wrong, an ungated settlement job would keep
 * paying out of the ledger built during the bad window. Turning the flag off has
 * to stop the money, not just the accrual.
 *
 * ⚠️ ROWS ARE NOT DROPPED WHEN THE FLAG IS OFF, only left unsettled. They stay
 * `accrued` and settle whenever the flag comes back on. That is the recoverable
 * direction: a viewer was genuinely debited for each one, so forgiving them
 * would keep the money rather than return it.
 */
export const settleBlockAuthorFeesJob = createJob(
  'settle-block-author-fees',
  '30 2 * * *',
  async () => {
    let enabled = false;
    try {
      enabled = await isAppBlocksAuthorFeeEnabled();
    } catch {
      // A flag read that will not resolve is not permission to pay anyone.
      // Same posture as `observeBlockAuthorFee`'s: fail closed.
      log('Flag read failed, skipping settlement');
      return;
    }

    if (!enabled) {
      log('Author fee disabled, skipping settlement');
      return;
    }

    // ⚠️ NO getJobDate/setLastRun CURSOR, DELIBERATELY. An earlier revision kept
    // one. It gated nothing: `settleBlockAuthorFees` scans `status: 'accrued'`
    // with no date filter, so the cursor was read only to interpolate into the
    // log line below and then written back — two DB round-trips and a persisted
    // KeyValue row that no branch consulted. The real idempotency mechanism is
    // the deterministic `externalTransactionId`, which does not consult a cursor:
    // a re-run of the same day conflicts on the key and mints nothing. A cursor
    // that looks like a run-once guard while guarding nothing is worse than none.
    const result = await settleBlockAuthorFees({ date: new Date() });

    log(
      `Settled ${result.rowsSettled} row(s) across ${result.buckets} bucket(s), ` +
        `${result.buzzMinted} buzz minted`
    );
  }
);
