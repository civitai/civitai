import { createJob } from './job';
import { reconcileDeposits } from '~/server/services/nowpayments.service';
import { logToAxiom } from '~/server/logging/client';
import dayjs from '~/shared/utils/dayjs';

export const reconcileNowpaymentsJob = createJob(
  'reconcile-nowpayments',
  '0 * * * *', // Every hour
  async () => {
    // Look back 1 day to catch payments that were still "confirming" during previous runs
    const now = dayjs.utc();
    const dateTo = now.format('YYYY-MM-DD');
    const dateFrom = now.clone().subtract(1, 'day').format('YYYY-MM-DD');

    const results = await reconcileDeposits({ dateFrom, dateTo });

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

    if (results.failed > 0) {
      const failedDetails = results.details.filter((d) => d.action === 'failed');
      logToAxiom({
        name: 'reconcile-nowpayments-job',
        type: 'error',
        message: `${results.failed} deposit(s) failed during reconciliation`,
        failedDetails,
      });
    }

    return {
      dateFrom,
      dateTo,
      ...results,
    };
  },
  {
    lockExpiration: 10 * 60, // 10 minutes — API pagination + processing can be slow
  }
);
