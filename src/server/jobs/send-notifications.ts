import { NotificationCategory, Prisma } from '@prisma/client';
import { isPromise } from 'util/types';
import { clickhouse } from '~/server/clickhouse/client';
import { notifDbWrite } from '~/server/db/notifDb';
import { pgDbRead } from '~/server/db/pgDb';
import { notificationBatches } from '~/server/notifications/utils.notifications';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import { createJob, getJobDate } from './job';

const log = createLogger('send-notifications', 'blue');

export type NotificationSingleRow = {
  key: string;
  userId: number;
  type: string;
  details: MixedObject;
};

export type NotificationPendingRow = Omit<NotificationSingleRow, 'userId'> & {
  users: number[];
  category: NotificationCategory;
};

export const sendNotificationsJob = createJob('send-notifications', '*/1 * * * *', async (e) => {
  try {
    const [lastRun, setLastRun] = await getJobDate('last-sent-notifications');

    // Run batches
    for (const batch of notificationBatches) {
      e.checkIfCanceled();
      const promises = batch.map(({ prepareQuery, key, category, displayName }) => async () => {
        e.checkIfCanceled();

        // TODO remove
        if (displayName !== 'New comments on your models') return;

        log('sending', key, 'notifications');
        const [lastSent, setLastSent] = await getJobDate('last-sent-notification-' + key, lastRun);
        let query = prepareQuery?.({
          lastSent: lastSent.toISOString(),
          clickhouse,
        });
        if (query) {
          const start = Date.now();
          if (isPromise(query)) query = await query;

          const request = await pgDbRead.cancellableQuery<NotificationSingleRow>(query);
          e.on('cancel', request.cancel);
          const additions = await request.result();

          const pendingData: { [k: string]: NotificationPendingRow } = {};
          for (const r of additions) {
            if (!r.key) {
              console.error('missing key for ', key);
              continue;
            }
            if (!pendingData.hasOwnProperty(r.key)) {
              pendingData[r.key] = {
                key: r.key,
                type: r.type,
                category: category,
                details: r.details,
                users: [r.userId],
              };
            } else {
              pendingData[r.key]['users'].push(r.userId);
            }
          }

          console.log({ pendingData });

          await notifDbWrite.cancellableQuery(Prisma.sql`
            INSERT INTO "PendingNotification" (key, type, category, users, details)
            VALUES
            ${Prisma.join(
              Object.values(pendingData).map(
                (d) =>
                  Prisma.sql`(${d.key}, ${d.type}, ${d.category}, ${
                    '{' + d.users.join(',') + '}'
                  }, ${JSON.stringify(d.details)}::jsonb)`
              )
            )}
              ON CONFLICT
            DO NOTHING
          `);

          // if (additions.length > 0) {
          //   counter.add(additions);
          // }

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
