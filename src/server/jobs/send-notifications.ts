import { createJob, getJobDate } from './job';
import { notificationBatches } from '~/server/notifications/utils.notifications';
import { createLogger } from '~/utils/logging';
import { isPromise } from 'util/types';
import { clickhouse } from '~/server/clickhouse/client';
import { pgDbWrite } from '~/server/db/pgDb';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  withNotificationCounter,
  NotificationAddedRow,
} from '~/server/notifications/notification-cache';

const log = createLogger('send-notifications', 'blue');

export const sendNotificationsJob = createJob('send-notifications', '*/1 * * * *', (e) =>
  withNotificationCounter(
    async (counter) => {
      const [lastRun, setLastRun] = await getJobDate('last-sent-notifications');

      // Run batches
      for (const batch of notificationBatches) {
        e.checkIfCanceled();
        const promises = batch.map(({ prepareQuery, key, category }) => async () => {
          e.checkIfCanceled();
          log('sending', key, 'notifications');
          const [lastSent, setLastSent] = await getJobDate(
            'last-sent-notification-' + key,
            lastRun
          );
          let query = prepareQuery?.({
            lastSent: lastSent.toISOString(),
            clickhouse,
            category: category ?? 'Other',
          });
          if (query) {
            const start = Date.now();
            if (isPromise(query)) query = await query;
            query = !query.includes('RETURNING') // If for any reason we're using returning inside a query this could break.
              ? query.replace(/;\s*$/, '') + ' RETURNING category, "userId"'
              : query;

            const request = await pgDbWrite.cancellableQuery<NotificationAddedRow>(query);
            e.on('cancel', request.cancel);
            const additions = await request.result();
            if (additions.length > 0) {
              counter.add(additions);
            }

            await setLastSent();
            log('sent', key, 'notifications in', (Date.now() - start) / 1000, 's');
          }
        });
        await limitConcurrency(promises, 4);
      }
      log('sent notifications');

      await setLastRun();
    },
    (e) => {
      log('failed to send notifications');
      throw e;
    }
  )
);
