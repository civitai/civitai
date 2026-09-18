import { createJob, getJobDate } from './job';
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

    const [lastRun, setLastRun] = await getJobDate('settle-block-author-fees', new Date());

    const result = await settleBlockAuthorFees({ date: new Date() });

    log(
      `Settled ${result.rowsSettled} row(s) across ${result.buckets} bucket(s), ` +
        `${result.buzzMinted} buzz minted, ` +
        `${result.bucketsSkippedNonPositive} bucket(s) held at non-positive net ` +
        `(last run ${lastRun.toISOString()})`
    );

    await setLastRun();
  }
);
