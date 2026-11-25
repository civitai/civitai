import { isEmpty } from 'lodash-es';
import { isPromise } from 'util/types';
import { clickhouse } from '~/server/clickhouse/client';
import { NotificationsClientError } from '@civitai/notifications';
import { notifications } from '~/server/notifications/client';
import { dbWrite } from '~/server/db/client';
import { pgDbRead } from '~/server/db/pgDb';
import { logToAxiom } from '~/server/logging/client';
import { notificationBatches } from '~/server/notifications/utils.notifications';
import { getMetricExcludedUserIds } from '~/server/services/metric-excluded-users.service';
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

/**
 * `KeyValue` row holding a JSON array of processor keys this job skips, e.g. `["new-model-version"]`.
 * Delete the row to resume. A resumed type sends only what its query's own lookback still reaches.
 */
export const PAUSED_NOTIFICATION_TYPES_KEY = 'paused-notification-types';

/** Throws on a malformed row so the run sends nothing rather than ignoring an intended pause. */
export async function getPausedNotificationTypes() {
  const row = await dbWrite.keyValue.findUnique({ where: { key: PAUSED_NOTIFICATION_TYPES_KEY } });
  if (!row) return new Set<string>();
  const value = row.value;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
    throw new Error(`${PAUSED_NOTIFICATION_TYPES_KEY} must be a JSON array of strings`);
  return new Set(value as string[]);
}

export const sendNotificationsJob = createJob('send-notifications', '*/1 * * * *', async (e) => {
  try {
    const [lastRun, setLastRun] = await getJobDate('last-sent-notifications');
    // The LENIENT reader: a milestone that fires on the pre-exclusion count is how these
    // behaved before; one that silently never fires is worse. Read once per run, not per
    // processor, and passed in because the processor files cannot import it.
    const excludedUserIds = await getMetricExcludedUserIds();
    const pausedTypes = await getPausedNotificationTypes();

    // Run batches
    for (const batch of notificationBatches) {
      e.checkIfCanceled();
      const promises = batch.map(({ prepareQuery, key, category }) => async () => {
        // Paused: no query and no setLastSent, so its cursor stays at the pause time.
        if (pausedTypes.has(key)) return;
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
            excludedUserIds,
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
                );
                continue;
              }
              if (!pendingData.hasOwnProperty(r.key)) {
                pendingData[r.key] = {
                  key: r.key,
                  type: r.type,
                  category: category,
                  details: r.details,
                  dedupeKey: r.dedupeKey ?? null,
                  users: [r.userId],
                };
              } else {
                pendingData[r.key]['users'].push(r.userId);
              }
            }

            if (!isEmpty(pendingData)) {
              // The UPDATE-first / INSERT-on-miss batching (to avoid burning sequence ids) now lives in
              // the notifications app behind createNotificationsBulk.
              await notifications.createNotificationsBulk(Object.values(pendingData));
            }

            await setLastSent();
            log('sent', key, 'notifications in', (Date.now() - start) / 1000, 's');
          }
        } catch (e) {
          // Client errors log centrally; skip to avoid a double log. The try also wraps the main-DB
          // query, so genuine query/build failures still log below; the key isn't marked sent → retries.
          if (e instanceof NotificationsClientError) return;
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
          );
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
    );
  }
});
