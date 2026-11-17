import { createJob } from './job';
import { refundOverPoolBoxes } from '~/server/services/mystery-box-over-pool.service';

/**
 * Refunds held boxes that can never open, finishes box refunds claimed but never paid back, and
 * continues box takedowns.
 */
export const mysteryBoxOverPoolRefundsJob = createJob(
  'mystery-box-over-pool-refunds',
  '17 * * * *',
  async () => refundOverPoolBoxes(),
  { lockExpiration: 30 * 60 }
);
