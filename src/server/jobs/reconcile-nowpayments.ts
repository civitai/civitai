import { createJob } from './job';
import { reconcileDeposits, retryFailedDeposits } from '~/server/services/nowpayments.service';
import { logToAxiom } from '~/server/logging/client';
import dayjs from '~/shared/utils/dayjs';

export const reconcileNowpaymentsJob = createJob(
  'reconcile-nowpayments',
  '*/10 * * * *', // Every 10 minutes
  async () => {
    // Phase 1: Rolling-window reconciliation.
    // NP's list API filters by created_at only, so a moving cursor permanently
    // misses any payment that reaches finished/partially_paid after the cursor
    // passes its creation time. Re-sweep a wide fixed lookback every run instead;
    // processDeposit is idempotent, so re-processing settled deposits is a no-op.
    const now = dayjs.utc();
    const dateFrom = now.subtract(72, 'hour').toISOString();
    const dateTo = now.subtract(1, 'minute').toISOString(); // Exclude present to avoid webhook race

    let results;
    try {
      results = await reconcileDeposits({ dateFrom, dateTo });
    } catch (e) {
      await logToAxiom({
        name: 'reconcile-nowpayments-job',
        type: 'error',
        message: `Reconciliation API error`,
        dateFrom,
        dateTo,
        error: e instanceof Error ? e.message : String(e),
      });
      results = null;
    }

    if (results) {
      logToAxiom({
        name: 'reconcile-nowpayments-job',
        type: 'info',
        message: `Reconciliation complete: ${results.newlyProcessed} processed, ${results.alreadyProcessed} already done, ${results.failed} failed`,
        dateFrom,
        dateTo,
        totalPayments: results.totalPayments,
        completedPayments: results.completedPayments,
        alreadyProcessed: results.alreadyProcessed,
        newlyProcessed: results.newlyProcessed,
        failed: results.failed,
        skipped: results.skipped,
      });
    }

    // Phase 2: Retry sweep for buzz_failed deposits (no window, runs every time)
    let retryResults = { retried: 0, succeeded: 0, failed: 0, exhausted: 0 };
    try {
      retryResults = await retryFailedDeposits();
    } catch (e) {
      await logToAxiom({
        name: 'reconcile-nowpayments-job',
        type: 'error',
        message: `Retry sweep error`,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    if (retryResults.retried > 0) {
      logToAxiom({
        name: 'reconcile-nowpayments-job',
        type: retryResults.exhausted > 0 ? 'error' : 'info',
        message: `Retry sweep: ${retryResults.succeeded} succeeded, ${retryResults.failed} still failing, ${retryResults.exhausted} exhausted`,
        ...retryResults,
      });
    }

    return {
      dateFrom,
      dateTo,
      ...(results ?? { totalPayments: 0, completedPayments: 0, alreadyProcessed: 0, newlyProcessed: 0, failed: 0, skipped: 0 }),
      retryResults,
    };
  },
  {
    lockExpiration: 10 * 60, // 10 minutes — API pagination + processing can be slow
  }
);
