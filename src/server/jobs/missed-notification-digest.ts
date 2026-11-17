import {
  DIGEST_RUN_BUDGET_MS,
  runMissedNotificationDigest,
} from '~/server/services/notification-digest.service';
import { createJob } from './job';

/**
 * The weekly email of notifications a user has not seen. Each user gets at most one a week; the
 * job runs hourly because sends are paced, so one pass over every user is spread across many runs,
 * each resuming where the last stopped (see `runMissedNotificationDigest`). Once a pass finishes,
 * runs do nothing until a week after it started.
 *
 * Gated per user on the `missed-notification-digest` Flipt flag, so a percentage rollout ramps it
 * and a flag that is off emails nobody. With the flag off a pass still pages through the user
 * table once a week, but asks the notifications app about no one. A pass that finished while the
 * flag was off is not rerun when it is turned on: the next pass starts a week after that one did.
 */
export const missedNotificationDigest = createJob(
  'missed-notification-digest',
  '17 * * * *',
  async (jobContext) =>
    runMissedNotificationDigest({ checkIfCanceled: jobContext.checkIfCanceled }),
  // Two concurrent runs could both read a user as not yet sent and email them twice, so the lock
  // outlives a scheduler hang-up and covers the whole run budget.
  { lockExpiration: Math.ceil(DIGEST_RUN_BUDGET_MS / 1000) + 10 * 60, keepLockOnDisconnect: true }
);
