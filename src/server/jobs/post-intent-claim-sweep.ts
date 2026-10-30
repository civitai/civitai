import { createJob } from './job';
import { sweepExpiredIntentClaims } from '~/server/services/post-intent/post-intent.service';

export const postIntentClaimSweep = createJob('post-intent-claim-sweep', '17 * * * *', async () => {
  const released = await sweepExpiredIntentClaims();
  return { released };
});
