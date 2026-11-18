import { createJob } from './job';
import { sweepCreatorBoxPayouts } from '~/server/services/creator-box-payout.service';

/**
 * Refunds and takedowns reverse a payout by its recorded transaction id, so an unrecorded one is
 * repaired here, not only logged.
 */
export const creatorBoxPayoutSweepJob = createJob(
  'creator-box-payout-sweep',
  '*/10 * * * *',
  async () => sweepCreatorBoxPayouts(),
  { lockExpiration: 30 * 60 }
);
