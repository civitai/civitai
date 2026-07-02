// Fan-out worker (B) — the external notification-server's src/app.ts poll loop, ported onto the shared
// @civitai/* clients. Every ~5s it claims a batch of PendingNotification rows, fans each into
// Notification + UserNotification rows (normal or debounced), deletes/reschedules the pending row, then
// POSTs a realtime signal per affected user. The DB/redis/axiom plumbing that was hand-forked in the
// external repo (src/db.ts, redis-client.ts, shared.ts) is gone — see the client shims.

import dayjs from 'dayjs';
import { chunk } from 'lodash-es';
import type { PoolClient } from 'pg';
import format from 'pg-format';
import { newNotificationSignal, type NotificationCategory } from '@civitai/notifications';
import { notifDbWrite } from '../lib/server/clients/db';
import { logAxiomError, logToAxiom } from '../lib/server/clients/axiom';
import { notificationCache } from '../lib/server/cache';
import { signalsEndpoint } from '../env';
import {
  notificationsFannedOutTotal,
  workerPendingProcessedTotal,
  workerTickSeconds,
  writePoolActive,
} from '../lib/server/metrics';

type PendingReturnRow = {
  id: number;
  type: string;
  category: NotificationCategory;
  key: string;
  users: number[];
  details: Record<string, any>;
  debounceSeconds: number | null;
  lastTriggered: string;
  nextSendAt: string;
};

type RetData = {
  id: number;
  userId: number;
  createdAt: string;
};

const appRunDelay = 5000;
const tooOld = '30min';
const rowsToFetch = 3000;
const insertBatchSize = 5000;
const signalBatchSize = 500;
const signalDelay = 500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const getPending = async (): Promise<PendingReturnRow[]> => {
  try {
    const query = await notifDbWrite().cancellableQuery<PendingReturnRow>(`
      WITH
        return_data AS (
          SELECT
            id, type, category, key, users, details,
            "debounceSeconds", "lastTriggered", "nextSendAt"
          FROM "PendingNotification"
          WHERE
            ("claimedAt" IS NULL OR "claimedAt" < NOW() - INTERVAL '${tooOld}')
            AND (
              "debounceSeconds" IS NULL
              OR ("debounceSeconds" IS NOT NULL AND NOW() >= "nextSendAt")
            )
          ORDER BY id
          LIMIT ${rowsToFetch}
        )
      UPDATE "PendingNotification" pn
      SET "claimedAt" = NOW()
      FROM return_data r
      WHERE r.id = pn.id
      RETURNING *
    `);
    return await query.result();
  } catch (e) {
    logAxiomError(e as Error);
    return [];
  }
};

const handleNormal = async (row: PendingReturnRow, client: PoolClient): Promise<RetData[]> => {
  const { id, key, type, category, details, users } = row;
  let retData: RetData[] = [];

  // SELECT first to avoid burning a Notification.id sequence value when the key already exists.
  const selectNotifQuery = format(`SELECT id FROM "Notification" WHERE key = %L`, key);
  const selectRes = await client.query<{ id: number }>(selectNotifQuery);
  let respId = selectRes.rows[0]?.id;

  if (!respId) {
    const insertNotifQuery = format(
      `INSERT INTO "Notification" (type, key, category, details) VALUES %L RETURNING id`,
      [[type, key, category, details]]
    );
    try {
      const insRes = await client.query<{ id: number }>(insertNotifQuery);
      respId = insRes.rows[0]?.id;
    } catch (err: any) {
      // 23505 = unique_violation: another writer inserted the same key between our SELECT and INSERT.
      if (err?.code === '23505') {
        const retryRes = await client.query<{ id: number }>(selectNotifQuery);
        respId = retryRes.rows[0]?.id;
      } else {
        throw err;
      }
    }
  }

  // Always run fan-out — Notification.key is shared across users, so a pre-existing key may still have
  // new users in this row. UserNotification's UNIQUE (notificationId, userId) dedups safely.
  if (respId) {
    const userMappedData = users.map((u) => [respId, u]);
    for (const batch of chunk(userMappedData, insertBatchSize)) {
      const insertUsersQuery = format(
        `INSERT INTO "UserNotification" ("notificationId", "userId")
         VALUES %L ON CONFLICT DO NOTHING RETURNING id, "userId", "createdAt"`,
        batch
      );
      const resUsers = await client.query<RetData>(insertUsersQuery);
      retData = retData.concat(resUsers.rows);
    }
  }

  await client.query(format(`DELETE FROM "PendingNotification" WHERE id = %L`, id));
  return retData;
};

const handleDebounce = async (row: PendingReturnRow, client: PoolClient): Promise<RetData[]> => {
  const { id, key, type, category, details, users, debounceSeconds, lastTriggered, nextSendAt } = row;
  let retData: RetData[] = [];

  if (
    dayjs(lastTriggered)
      .add(debounceSeconds as number, 'seconds')
      .isBefore(dayjs(nextSendAt))
  ) {
    await client.query(format(`DELETE FROM "PendingNotification" WHERE id = %L`, id));
    return retData;
  }

  // UPDATE-first to avoid burning a Notification.id sequence value on an existing key.
  const updateRes = await client.query<{ id: number }>(
    format(`UPDATE "Notification" SET "details" = %L WHERE "key" = %L RETURNING id`, details, key)
  );
  let respId = updateRes.rows[0]?.id;

  if (!respId) {
    const insertNotifQuery = format(
      `INSERT INTO "Notification" (type, key, category, details)
       VALUES %L ON CONFLICT ("key") DO UPDATE SET "details" = EXCLUDED."details" RETURNING id`,
      [[type, key, category, details]]
    );
    const insRes = await client.query<{ id: number }>(insertNotifQuery);
    respId = insRes.rows[0]?.id;
  }

  if (respId) {
    const userMappedData = users.map((u) => [respId, u]);
    for (const batch of chunk(userMappedData, insertBatchSize)) {
      const insertUsersQuery = format(
        `INSERT INTO "UserNotification" ("notificationId", "userId")
         VALUES %L ON CONFLICT ("notificationId", "userId") DO UPDATE
         SET "createdAt" = now(), viewed = FALSE RETURNING id, "userId", "createdAt"`,
        batch
      );
      const resUsers = await client.query<RetData>(insertUsersQuery);
      retData = retData.concat(resUsers.rows);
    }
  }

  await client.query(
    format(
      `UPDATE "PendingNotification"
       SET "claimedAt" = null, "nextSendAt" = now() + CONCAT("debounceSeconds", ' seconds')::interval
       WHERE id = %L`,
      id
    )
  );
  return retData;
};

const create = async (row: PendingReturnRow): Promise<RetData[] | undefined> => {
  if (row.category === 'Other')
    logToAxiom({ type: 'warning', message: 'Missing category', data: { type: row.type } }).catch(
      () => {}
    );

  const client = await notifDbWrite().connect();
  // pg drops its own error handler from a checked-out client — the consumer owns it. This connection is
  // held across a whole BEGIN/COMMIT; a server-initiated socket reset mid-transaction would emit an
  // unhandled 'error' event and crash the process. Attach a listener (removed before release so it can't
  // accumulate one-per-call on the reused connection).
  const onClientError = (err: Error) => {
    // eslint-disable-next-line no-console
    console.error('Postgres write checked-out client error:', err.message);
    logAxiomError(err);
  };
  client.on('error', onClientError);
  try {
    await client.query('BEGIN');
    const ret =
      row.debounceSeconds !== null
        ? await handleDebounce(row, client)
        : await handleNormal(row, client);
    await client.query('COMMIT');
    return ret;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logAxiomError(e as Error);
    return undefined;
  } finally {
    client.removeListener('error', onClientError);
    client.release();
  }
};

const run = async () => {
  const rows = await getPending();
  for (const row of rows) {
    const affectedUsers = await create(row);
    if (!affectedUsers) {
      workerPendingProcessedTotal.inc({ outcome: 'errored' });
      continue;
    }
    workerPendingProcessedTotal.inc({ outcome: 'fanned' });
    notificationsFannedOutTotal.inc(affectedUsers.length);

    const signalData = { type: row.type, category: row.category, details: row.details };
    const affectBatches = chunk(affectedUsers, signalBatchSize);
    for (let i = 0; i < affectBatches.length; i++) {
      for (const { userId, id, createdAt } of affectBatches[i]!) {
        await notificationCache.incrementUser(userId, row.category);
        fetch(`${signalsEndpoint}/users/${userId}/signals/${newNotificationSignal}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...signalData, id, createdAt, read: false }),
        }).catch((e) => logAxiomError(e as Error));
      }
      if (i < affectBatches.length - 1) await sleep(signalDelay);
    }
  }
};

/**
 * Start the self-rescheduling poll loop. Each tick fully awaits run() before scheduling the next — a
 * plain setInterval would fire regardless of in-flight work and pile ticks up, starving the write pool.
 * Returns a stop() that halts scheduling after the current tick settles.
 */
export function startWorker(): { stop: () => void } {
  let stopped = false;

  const scheduleTick = () => {
    if (stopped) return;
    setTimeout(async () => {
      if (stopped) return;
      const end = workerTickSeconds.startTimer();
      try {
        await run();
      } catch (e) {
        logAxiomError(e as Error);
      } finally {
        end();
        const w = notifDbWrite();
        writePoolActive.set(w.totalCount - w.idleCount);
      }
      scheduleTick();
    }, appRunDelay);
  };

  scheduleTick();
  return {
    stop: () => {
      stopped = true;
    },
  };
}
