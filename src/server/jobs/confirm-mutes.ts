import { dbWrite } from '~/server/db/client';
import { cancelSubscription } from '~/server/services/stripe.service';
import { refreshSession } from '~/server/auth/session-invalidation';
import { createJob, getJobDate } from './job';
import { cancelSubscriptionPlan } from '~/server/services/paddle.service';

export const confirmMutes = createJob('confirm-mutes', '0 1 * * *', async () => {
  // Get all recently confirmed mutes. `mutedAt` is only set on moderator
  // confirmation (uphold/retool/scam auto-mute), so a non-null recent value
  // signifies a confirmed mute. Pending auto-mutes leave it null.
  const [lastRan, setLastRan] = await getJobDate('confirm-mutes');
  const confirmedMutes = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT id
    FROM "User"
    WHERE "muted" AND "mutedAt" > ${lastRan}
  `;

  // For each confirmed mute, cancel any subscriptions and refresh the session
  for (const { id } of confirmedMutes) {
    try {
      await cancelSubscriptionPlan({ userId: id });
      await cancelSubscription({ userId: id, atPeriodEnd: true });
      await refreshSession(id);
    } catch (e) {
      console.error(`Error cancelling subscription for user ${id}:`, e);
    }
  }

  await setLastRan();
});
