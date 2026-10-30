import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { createJob } from './job';

/**
 * CustomerSubscriptionHistory is kept by a trigger that swallows its own errors so it can never
 * block a billing write. This repairs anything it missed (or anything written with the trigger
 * off): live rows without a matching open history row, and open rows whose slot is gone.
 */
export const reconcileSubscriptionHistoryJob = createJob(
  'reconcile-subscription-history',
  '30 2 * * *',
  async () => {
    const [result] = await dbWrite.$queryRaw<{ refreshed: number; closed: number }[]>`
      SELECT refreshed, closed FROM customer_subscription_history_reconcile()
    `;

    // Any repair means the trigger missed a write, which is worth knowing about.
    if (result && (result.refreshed > 0 || result.closed > 0)) {
      await logToAxiom({
        name: 'reconcile-subscription-history',
        type: 'warning',
        message: 'Repaired CustomerSubscriptionHistory drift',
        refreshed: result.refreshed,
        closed: result.closed,
      }).catch(() => null);
    }

    return result;
  }
);
