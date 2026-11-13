import { createJob } from './job';
import { sweepCreatorBoxPayouts } from '~/server/services/creator-box-payout.service';

/**
 * Pays creator-box sales whose payout the purchase didn't record. Refunds and takedowns reverse a
 * payout by its recorded transaction id, so a missed one is repaired here, not only logged.
 */
export const creatorBoxPayoutSweepJob = createJob(
  'creator-box-payout-sweep',
  '*/10 * * * *',
  async () => sweepCreatorBoxPayouts(),
  { lockExpiration: 30 * 60 }
);
