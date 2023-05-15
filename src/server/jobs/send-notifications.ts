import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { notificationBatches } from '~/server/notifications/utils.notifications';
import { createLogger } from '~/utils/logging';

const log = createLogger('send-notifications', 'blue');

export const sendNotificationsJob = createJob('send-notifications', '*/1 * * * *', async () => {
  try {
    const [lastRun, setLastRun] = await getJobDate('last-sent-notifications');

    // Run batches
    for (const batch of notificationBatches) {
      const promises = batch.map(async ({ prepareQuery, key }) => {
        const [lastSent, setLastSent] = await getJobDate('last-sent-notification-' + key, lastRun);
        const query = prepareQuery?.({ lastSent: lastSent.toISOString() });
        if (query) {
          const now = new Date(); // Use time before query is executed to avoid gaps
          await dbWrite.$executeRawUnsafe(query);
          await setLastSent(now);
        }
      });
      await Promise.all(promises);
    }
    log('sent notifications');

    await setLastRun();
  } catch {
    log('failed to send notifications');
  }
});
