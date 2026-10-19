import { createJob } from './job';
import { sweepWithdrawnShopRefunds } from '~/server/services/creator-shop-withdrawn-refund.service';

/**
 * Finishes the buyer refunds a rejection or a withheld archive started: the request refunds only
 * the first purchases, and a Buzz failure, a lock held elsewhere, or a process that died mid-run
 * leaves others unrefunded. Nothing else comes back for them.
 */
export const creatorShopWithdrawnRefundsJob = createJob(
  'creator-shop-withdrawn-refunds',
  '*/10 * * * *',
  async () => sweepWithdrawnShopRefunds(),
  { lockExpiration: 30 * 60 }
);
