import { createJob, getJobDate } from './job';
import { notificationBatches } from '~/server/notifications/utils.notifications';
import { createLogger } from '~/utils/logging';
import { isPromise } from 'util/types';
import { clickhouse } from '~/server/clickhouse/client';
import { pgDbWrite } from '~/server/db/pgDb';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const log = createLogger('send-notifications', 'blue');

export const sendNotificationsJob = createJob('send-notifications', '*/1 * * * *', async (e) => {
  try {
    const [lastRun, setLastRun] = await getJobDate('last-sent-notifications');

    // Run batches
    for (const batch of notificationBatches) {
      e.checkIfCanceled();
      const promises = batch.map(({ prepareQuery, key, category }) => async () => {
        e.checkIfCanceled();
        log('sending', key, 'notifications');
        const [lastSent, setLastSent] = await getJobDate('last-sent-notification-' + key, lastRun);
        let query = prepareQuery?.({
          lastSent: lastSent.toISOString(),
          clickhouse,
          category: category ?? 'Other',
        });
        if (query) {
          const start = Date.now();
          if (isPromise(query)) query = await query;

          const request = await pgDbWrite.cancellableQuery(query);
          e.on('cancel', request.cancel);
          await request.result();
          await setLastSent();
          log('sent', key, 'notifications in', (Date.now() - start) / 1000, 's');
        }
      });
      await limitConcurrency(promises, 4);
    }
    log('sent notifications');

    await setLastRun();
  } catch (e) {
    log('failed to send notifications');
    throw e;
  }
});
