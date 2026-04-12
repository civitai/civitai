import { Prisma } from '@prisma/client';
import { chunk, isEmpty } from 'lodash-es';
import { isPromise } from 'util/types';
import { clickhouse } from '~/server/clickhouse/client';
import { notifDbWrite } from '~/server/db/notifDb';
import { pgDbRead } from '~/server/db/pgDb';
import { logToAxiom } from '~/server/logging/client';
import { notificationBatches } from '~/server/notifications/utils.notifications';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import { createJob, getJobDate } from './job';
import type {
  NotificationSingleRow,
  NotificationPendingRow,
} from '~/server/schema/notification.schema';

const log = createLogger('send-notifications', 'blue');

const batchSize = 5000;
const concurrent = 8;
const MAX_NOTIFICATION_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export const sendNotificationsJob = createJob('send-notifications', '*/1 * * * *', async (e) => {
  try {
    const [lastRun, setLastRun] = await getJobDate('last-sent-notifications');

    // Run batches
    for (const batch of notificationBatches) {
      e.checkIfCanceled();
      const promises = batch.map(({ prepareQuery, key, category }) => async () => {
        let isWindowCapped = false;
        let effectiveNowDate = new Date();
        let setLastSent: (date?: Date) => Promise<void | null> = async () => null;

        try {
          e.checkIfCanceled();
          log('sending', key, 'notifications');
          const [lastSent, _setLastSent] = await getJobDate(
            'last-sent-notification-' + key,
            lastRun
          );
          setLastSent = _setLastSent;

          // Cap the query window to prevent death spiral when cursor falls behind.
          // If lastSent is too far in the past, limit the window and catch up incrementally.
          const runTime = new Date();
          const windowMs = runTime.getTime() - lastSent.getTime();
          isWindowCapped = windowMs > MAX_NOTIFICATION_WINDOW_MS;
          effectiveNowDate = isWindowCapped
            ? new Date(lastSent.getTime() + MAX_NOTIFICATION_WINDOW_MS)
            : runTime;
          const effectiveNow = effectiveNowDate.toISOString();

          if (isWindowCapped) {
            logToAxiom(
              {
                type: 'warning',
                name: 'Notification window capped',
                details: { key, lastSent: lastSent.toISOString(), windowMs, effectiveNow },
              },
              'notifications'
            ).catch();
          }

          let query = prepareQuery?.({
            lastSent: lastSent.toISOString(),
            lastSentDate: lastSent,
            clickhouse,
            effectiveNow,
          });
          if (query) {
            const start = Date.now();
            if (isPromise(query)) query = await query;
            if (!query) return;

            const request = await pgDbRead.cancellableQuery<NotificationSingleRow>(query);
            e.on('cancel', request.cancel);
            const additions = await request.result();

            const pendingData: { [k: string]: NotificationPendingRow } = {};
            for (const r of additions) {
              if (!r.key) {
                logToAxiom(
                  {
                    type: 'warning',
                    message: `Missing key for: ${key}`,
                  },
                  'notifications'
                ).catch();
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

            if (!isEmpty(pendingData)) {
              const batches = chunk(Object.values(pendingData), batchSize);
              for (const batch of batches) {
                //language=text
                const insertQuery = Prisma.sql`
                INSERT INTO "PendingNotification" (key, type, category, users, details)
                VALUES
                ${Prisma.join(
                  batch.map(
                    (d) =>
                      Prisma.sql`(${d.key}, ${d.type}, ${d.category}, ${
                        '{' + d.users.join(',') + '}'
                      }, ${JSON.stringify(d.details)}::jsonb)`
                  )
                )}
                ON CONFLICT (key) DO UPDATE SET "users" = excluded."users", "lastTriggered" = NOW()
              `;

                const resp = await notifDbWrite.cancellableQuery(insertQuery);
                await resp.result();
              }
            }

            await setLastSent(effectiveNowDate);
            log('sent', key, 'notifications in', (Date.now() - start) / 1000, 's');
          }
        } catch (e) {
          const error = e as Error;
          const isTimeout = error.message?.includes('statement timeout');

          // If the query timed out and the window was already capped,
          // advance the cursor anyway to prevent permanent stall.
          if (isTimeout && isWindowCapped) {
            logToAxiom(
              {
                type: 'error',
                name: 'Notification query timed out with capped window - advancing cursor',
                details: {
                  key,
                  effectiveNow: effectiveNowDate.toISOString(),
                  message: error.message,
                },
              },
              'notifications'
            ).catch();
            await setLastSent(effectiveNowDate).catch(() => null);
          }

          logToAxiom(
            {
              type: 'error',
              name: 'Failed to insert notifications',
              details: { key },
              message: error.message,
              stack: error.stack,
              causeMessage: error?.cause instanceof Error ? error.cause.message : undefined,
            },
            'notifications'
          ).catch();
        }
      });

      await limitConcurrency(promises, concurrent);
    }

    log('sent notifications');

    await setLastRun();
  } catch (e) {
    const error = e as Error;
    logToAxiom(
      {
        type: 'error',
        name: 'Failed to send notifications',
        message: error.message,
        stack: error.stack,
        causeMessage: error?.cause instanceof Error ? error.cause.message : undefined,
      },
      'notifications'
    ).catch();
  }
});
