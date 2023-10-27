import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { notificationBatches } from '~/server/notifications/utils.notifications';
import { createLogger } from '~/utils/logging';
import { isPromise } from 'util/types';
import { clickhouse } from '~/server/clickhouse/client';

const log = createLogger('send-notifications', 'blue');

export const sendNotificationsJob = createJob('send-notifications', '*/1 * * * *', async () => {
  try {
    const [lastRun, setLastRun] = await getJobDate('last-sent-notifications');

    // Run batches
    for (const batch of notificationBatches) {
      const promises = batch.map(async ({ prepareQuery, key }) => {
        const [lastSent, setLastSent] = await getJobDate('last-sent-notification-' + key, lastRun);
        let query = prepareQuery?.({ lastSent: lastSent.toISOString(), clickhouse });
        if (query) {
          if (isPromise(query)) query = await query;

          await dbWrite.$executeRawUnsafe(query);
          await setLastSent();
        }
      });
      await Promise.allSettled(promises);
    }
    log('sent notifications');

    await setLastRun();
  } catch (e) {
    log('failed to send notifications');
    throw e;
  }
});
