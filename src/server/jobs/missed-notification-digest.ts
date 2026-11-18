import {
  DIGEST_RUN_BUDGET_MS,
  runMissedNotificationDigest,
} from '~/server/services/notification-digest.service';
import { createJob } from './job';

/** A pass that finished while the flag was off is not rerun when it is turned on. */
export const missedNotificationDigest = createJob(
  'missed-notification-digest',
  '17 * * * *',
  async (jobContext) =>
    runMissedNotificationDigest({ checkIfCanceled: jobContext.checkIfCanceled }),
  // Two concurrent runs could both read a user as not yet sent and email them twice, so the lock
  // outlives a scheduler hang-up and covers the whole run budget.
  { lockExpiration: Math.ceil(DIGEST_RUN_BUDGET_MS / 1000) + 10 * 60, keepLockOnDisconnect: true }
);
