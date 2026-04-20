import { createJob } from './job';
import { expireSettledTokens, settleDueRewards } from '~/server/services/referral.service';

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
