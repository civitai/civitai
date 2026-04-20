import { createJob } from './job';
import {
  advanceReferralSubscriptions,
  expireSettledTokens,
  settleDueRewards,
} from '~/server/services/referral.service';

export const settleReferralRewards = createJob(
  'settle-referral-rewards',
  '*/15 * * * *',
  async () => {
    await settleDueRewards();
  }
);

export const expireReferralTokens = createJob('expire-referral-tokens', '17 3 * * *', async () => {
  await expireSettledTokens();
});

// Advances referral subs that have hit currentPeriodEnd: promotes the next
// queued tier chunk, or cancels the sub if nothing is queued. Runs hourly so a
// user whose chunk ends mid-day doesn't lose access for long.
export const advanceReferralSubs = createJob('advance-referral-subs', '5 * * * *', async () => {
  await advanceReferralSubscriptions();
});
