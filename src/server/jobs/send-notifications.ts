import { isEmpty } from 'lodash-es';
import { isPromise } from 'util/types';
import { clickhouse } from '~/server/clickhouse/client';
import { createNotificationsBulk } from '@civitai/notifications';
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

const concurrent = 8;

// Hard ceiling on prepareQuery read duration. Each query has a per-processor SQL floor
// limiting the lookback window to ~30 minutes of data, so this is generous headroom.
// Hitting this ceiling means something pathological is going on (replica regression,
// missing index, etc.) - cancel the backend query and surface a clean error to Axiom
// instead of waiting for a non-deterministic pg-pool connection-termination timeout.
const NOTIFICATION_QUERY_TIMEOUT_MS = 20_000;

export const sendNotificationsJob = createJob('send-notifications', '*/1 * * * *', async (e) => {
  try {
    const [lastRun, setLastRun] = await getJobDate('last-sent-notifications');

    // Run batches
    for (const batch of notificationBatches) {
      e.checkIfCanceled();
      const promises = batch.map(({ prepareQuery, key, category }) => async () => {
        try {
          e.checkIfCanceled();
          log('sending', key, 'notifications');
          const [lastSent, setLastSent] = await getJobDate(
            'last-sent-notification-' + key,
            lastRun
          );

          let query = prepareQuery?.({
            lastSent: lastSent.toISOString(),
            lastSentDate: lastSent,
            clickhouse,
          });
          if (query) {
            const start = Date.now();
            if (isPromise(query)) query = await query;
            if (!query) return;

            const request = await pgDbRead.cancellableQuery<NotificationSingleRow>(query);
            e.on('cancel', request.cancel);

            let timeoutId: NodeJS.Timeout | undefined;
            const additions = await Promise.race([
              request.result(),
              new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => {
                  // pg_cancel_backend() the running query so the connection is freed
                  // immediately rather than tying up a pool slot until pg-pool gives up.
                  request.cancel().catch(() => null);
                  reject(
                    new Error(
                      `Notification query timeout after ${NOTIFICATION_QUERY_TIMEOUT_MS}ms (key=${key})`
                    )
                  );
                }, NOTIFICATION_QUERY_TIMEOUT_MS);
              }),
            ]).finally(() => {
              if (timeoutId) clearTimeout(timeoutId);
            });

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
              // The UPDATE-first / INSERT-on-miss batching (to avoid burning sequence ids) now lives in
              // the notifications app behind createNotificationsBulk.
              await createNotificationsBulk(Object.values(pendingData));
            }

            await setLastSent();
            log('sent', key, 'notifications in', (Date.now() - start) / 1000, 's');
          }
        } catch (e) {
          const error = e as Error;
          logToAxiom(
            {
              type: 'error',
              name: 'Failed to insert notifications',
              details: { key },
              message: error.message,
              stack: error.stack,
              cause: error.cause,
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
        cause: error.cause,
      },
      'notifications'
    ).catch();
  }
});
