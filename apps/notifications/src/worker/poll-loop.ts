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
import { health } from '../lib/server/health';
import { dispatchEmail } from './email';
import { dispatchPush } from './push';
import { counterBumpTimeoutMs, signalsEndpoint } from '../env';
import {
  notificationsFannedOutTotal,
  signalsDeliveryTotal,
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
  dedupeKey: string | null;
};

type RetData = {
  id: number;
  userId: number;
  createdAt: string;
};

const appRunDelay = 5000;
const tooOld = '30min';
const rowsToFetch = 3000;
// Rows with more recipients than this run in their own lane, so a follower fan-out that takes minutes
// to signal cannot hold up the rows queued behind it.
const bulkRecipients = 1000;
const insertBatchSize = 5000;
const signalBatchSize = 500;
const signalDelay = 500;
// Consecutive failed counter bumps after which the rest of the tick stops trying. While redis is down
// every bump fails, and even bounded ones add up over thousands of recipients.
const counterFailuresBeforeSkip = 3;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bump one recipient's unread counter within `counterBumpTimeoutMs`. Resolves whether it succeeded. */
async function bumpCounter(userId: number, category: NotificationCategory): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      health.recordRedisFailure();
      resolve(false);
    }, counterBumpTimeoutMs);
  });
  const bumped = notificationCache.incrementUser(userId, category).then(
    () => true,
    () => false
  );
  try {
    return await Promise.race([bumped, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

type Lane = 'normal' | 'bulk';

// Batch-claim query for due PendingNotification rows. `FOR UPDATE SKIP LOCKED` on the inner SELECT is the
// load-bearing concurrency guard: without it, two workers' CTE SELECTs can pick the SAME rows (the SELECT
// takes no locks), and the outer UPDATE's `WHERE r.id = pn.id` does NOT re-check `claimedAt IS NULL` — so
// the second UPDATE, once it unblocks on the first's row lock, re-stamps `claimedAt` and RETURNS the same
// rows → both workers fan the batch out (double signals + debounce rows resurrected via the ON CONFLICT
// DO UPDATE ... viewed=FALSE path). The worker Deployment is replicas:1 + strategy:Recreate today, so no
// two workers run concurrently in normal operation; SKIP LOCKED makes the claim correct regardless of
// replica count (an accidental scale-up or a future HA change can't cause double fan-out). With a single
// worker there is zero contention, so this clause is a no-op on the happy path.
const claimQuery = (lane: Lane) => `
  WITH
    return_data AS (
      SELECT
        id, type, category, key, users, details,
        "debounceSeconds", "lastTriggered", "nextSendAt", "dedupeKey"
      FROM "PendingNotification"
      WHERE
        ("claimedAt" IS NULL OR "claimedAt" < NOW() - INTERVAL '${tooOld}')
        AND (
          "debounceSeconds" IS NULL
          OR ("debounceSeconds" IS NOT NULL AND NOW() >= "nextSendAt")
        )
        AND cardinality(users) ${lane === 'bulk' ? '>' : '<='} ${bulkRecipients}
      ORDER BY id
      LIMIT ${lane === 'bulk' ? 1 : rowsToFetch}
      FOR UPDATE SKIP LOCKED
    )
  UPDATE "PendingNotification" pn
  SET "claimedAt" = NOW()
  FROM return_data r
  WHERE r.id = pn.id
  RETURNING *
`;

export const PENDING_CLAIM_QUERY = claimQuery('normal');
// One row per claim: each bulk row takes minutes, so the tail of a batch claim would sit claimed past the
// stale-claim window before its turn came.
export const BULK_CLAIM_QUERY = claimQuery('bulk');

const getPending = async (lane: Lane): Promise<PendingReturnRow[]> => {
  try {
    const query = await notifDbWrite().cancellableQuery<PendingReturnRow>(
      lane === 'bulk' ? BULK_CLAIM_QUERY : PENDING_CLAIM_QUERY
    );
    return await query.result();
  } catch (e) {
    logAxiomError(e as Error);
    return [];
  }
};

// Exported for behavioral unit tests (fake PoolClient). Export-for-test only — logic unchanged.
export const handleNormal = async (
  row: PendingReturnRow,
  client: PoolClient
): Promise<RetData[]> => {
  const { id, key, type, category, details, users, dedupeKey } = row;
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
  //
  // The untargeted ON CONFLICT DO NOTHING covers BOTH unique constraints, which is what makes cross-type
  // dedup work: a recipient who already has a row carrying this `dedupeKey` (from a different type fired
  // for the same source event) trips the partial UNIQUE ("userId", "dedupeKey") and is skipped. Skipped
  // rows are absent from RETURNING, so they also produce no signal and no unread-count increment.
  if (respId) {
    const userMappedData = users.map((u) => [respId, u, dedupeKey]);
    for (const batch of chunk(userMappedData, insertBatchSize)) {
      const insertUsersQuery = format(
        `INSERT INTO "UserNotification" ("notificationId", "userId", "dedupeKey")
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

// Exported for behavioral unit tests (fake PoolClient). Export-for-test only — logic unchanged.
export const handleDebounce = async (
  row: PendingReturnRow,
  client: PoolClient
): Promise<RetData[]> => {
  const { id, key, type, category, details, users, debounceSeconds, lastTriggered, nextSendAt } =
    row;
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

  // This INSERT omits "dedupeKey" entirely, so a debounced row writes NULL and is excluded from the
  // partial unique index — a dedupeKey on a debounced row is silently DROPPED, not honored. That is
  // deliberate: the targeted ON CONFLICT below is what lets a debounce re-surface a notification
  // (createdAt/viewed reset), and it could not absorb a violation of the other index. The producer
  // contract rejects the combination outright (see createNotificationPendingRow), so this is
  // unreachable — belt and braces. Teaching debounced types to dedup means reworking this INSERT.
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

// Exported for behavioral unit tests. Export-for-test only — logic unchanged.
export const create = async (row: PendingReturnRow): Promise<RetData[] | undefined> => {
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

// Exported for behavioral unit tests. Export-for-test only — logic unchanged.
export const run = async (lane: Lane = 'normal') => {
  const rows = await getPending(lane);
  let counterFailures = 0;
  for (const row of rows) {
    const start = Date.now();
    const affectedUsers = await create(row);
    health.markWorkerProgress(lane);
    if (!affectedUsers) {
      workerPendingProcessedTotal.inc({ outcome: 'errored' });
      continue;
    }
    workerPendingProcessedTotal.inc({ outcome: 'fanned' });
    notificationsFannedOutTotal.inc(affectedUsers.length);

    // Siblings of the signals POST below: runs after the DB write committed, on a recipient list
    // that already passed the opt-out filter. Awaited (unlike signals) because it does its own
    // pacing-sensitive outbound calls; it never throws.
    const affectedUserIds = affectedUsers.map((u) => u.userId);
    await dispatchPush(row.type, row.details, affectedUserIds);
    await dispatchEmail(row.type, row.details, affectedUserIds);

    const signalData = { type: row.type, category: row.category, details: row.details };
    const affectBatches = chunk(affectedUsers, signalBatchSize);
    for (let i = 0; i < affectBatches.length; i++) {
      for (const { userId, id, createdAt } of affectBatches[i]!) {
        // A failed or stuck counter bump must not cost the remaining recipients their signals.
        if (counterFailures < counterFailuresBeforeSkip) {
          counterFailures = (await bumpCounter(userId, row.category)) ? 0 : counterFailures + 1;
        }
        // Fire-and-forget (resilience unchanged): a signals failure must NOT break fan-out. We only add
        // outcome counting — non-2xx AND network/throw both count as `failure` (the old server silently
        // POSTed to a non-existent endpoint; that drop is now scrapeable).
        fetch(`${signalsEndpoint}/users/${userId}/signals/${newNotificationSignal}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...signalData, id, createdAt, read: false }),
        })
          .then((res) => {
            signalsDeliveryTotal.inc({ outcome: res.ok ? 'success' : 'failure' });
          })
          .catch((e) => {
            signalsDeliveryTotal.inc({ outcome: 'failure' });
            logAxiomError(e as Error);
          });
      }
      health.markWorkerProgress(lane);
      if (i < affectBatches.length - 1) await sleep(signalDelay);
    }

    if (lane === 'bulk')
      logToAxiom({
        type: 'info',
        name: 'Bulk fan-out',
        details: {
          key: row.key,
          type: row.type,
          recipients: affectedUsers.length,
          ms: Date.now() - start,
        },
      }).catch(() => {});
  }
};

/**
 * Start the self-rescheduling poll loop, one per lane. Each tick fully awaits run() before scheduling the
 * next — a plain setInterval would fire regardless of in-flight work and pile ticks up, starving the write
 * pool. Returns a stop() that halts scheduling of every lane after its current tick settles.
 */
export function startWorker(): { stop: () => void } {
  const lanes = (['normal', 'bulk'] as const).map(startLane);
  return {
    stop: () => lanes.forEach((lane) => lane.stop()),
  };
}

function startLane(lane: Lane): { stop: () => void } {
  let stopped = false;
  health.markWorkerStarted(lane);

  const scheduleTick = () => {
    if (stopped) return;
    setTimeout(async () => {
      if (stopped) return;
      const end = workerTickSeconds.startTimer();
      try {
        await run(lane);
      } catch (e) {
        logAxiomError(e as Error);
      } finally {
        end();
        health.markWorkerProgress(lane);
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
