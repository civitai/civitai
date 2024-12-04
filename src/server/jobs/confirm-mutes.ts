import { dbWrite } from '~/server/db/client';
import { cancelSubscription } from '~/server/services/stripe.service';
import { invalidateSession } from '~/server/utils/session-helpers';
import { createJob, getJobDate } from './job';
import { cancelSubscriptionPlan } from '~/server/services/paddle.service';

export const confirmMutes = createJob('confirm-mutes', '0 1 * * *', async () => {
  // Get all recently confirmed mutes
  const [lastRan, setLastRan] = await getJobDate('confirm-mutes');
  const confirmedMutes = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT id
    FROM "User"
    WHERE "muted" AND "muteConfirmedAt" > ${lastRan}
  `;

  // For each confirmed mute, cancel any subscriptions and refresh the session
  for (const { id } of confirmedMutes) {
    try {
      await cancelSubscriptionPlan({ userId: id });
      await cancelSubscription({ userId: id });
      await invalidateSession(id);
    } catch (e) {
      console.error(`Error cancelling subscription for user ${id}:`, e);
    }
  }

  await setLastRan();
});
