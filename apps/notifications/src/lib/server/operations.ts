// The notif-DB read/mark/bulk/exists/cleanup operations — ported from the monolith's
// notification.service.ts (getUserNotifications base query, getUserNotificationCount, markNotificationsRead
// with its per-user serialization queue + transient-error retry) and the send-notifications job (bulk
// UPSERT). Now that this app owns the notif pools + cache + lag window, these live here; the monolith
// calls them over HTTP via @civitai/notifications and keeps only the main-DB `details` enrichment.

import format from 'pg-format';
import { chunk } from 'lodash-es';
import type {
  CreateNotificationRow,
  MarkReadInput,
  NotificationCategory,
  NotificationRow,
} from '@civitai/notifications';
import { notifDbRead, notifDbWrite } from './clients/db';
import { notificationCache, type NotificationCategoryCount } from './cache';
import { getNotifDbWithoutLag, isWritePool, preventReplicationLag } from './lag';
import { logToAxiom, safeError } from './clients/axiom';

const bulkBatchSize = 5000;

// --- bulk producer path (pre-resolved recipients, NO opt-out filter) --------------------------------
export async function createNotificationsBulk(rows: CreateNotificationRow[]): Promise<void> {
  if (rows.length === 0) return;
  const write = notifDbWrite();

  for (const batch of chunk(rows, bulkBatchSize)) {
    // UPDATE-first to avoid burning sequence ids on existing keys: a multi-row INSERT ... ON CONFLICT
    // calls nextval() for every VALUES row before the conflict check, so an all-conflict batch burns one
    // id per row. UPDATE the existing keys, then INSERT only the misses.
    const updateValues = batch
      .map((d) => format('(%L, %L)', d.key, `{${d.users.join(',')}}`))
      .join(',');
    const updateResp = await write.cancellableQuery<{ key: string }>(`
      UPDATE "PendingNotification" pn
      SET "users" = u.users::int[], "lastTriggered" = NOW()
      FROM (VALUES ${updateValues}) AS u(key, users)
      WHERE pn."key" = u.key
      RETURNING pn."key"
    `);
    const updated = new Set((await updateResp.result()).map((r) => r.key));

    const toInsert = batch.filter((d) => !updated.has(d.key));
    if (toInsert.length) {
      const insertValues = toInsert
        .map((d) =>
          format(
            '(%L, %L, %L::"NotificationCategory", %L, %L::jsonb, %L)',
            d.key,
            d.type,
            d.category,
            `{${d.users.join(',')}}`,
            JSON.stringify(d.details),
            d.debounceSeconds ?? null
          )
        )
        .join(',');
      const insertResp = await write.cancellableQuery(`
        INSERT INTO "PendingNotification" (key, type, category, users, details, "debounceSeconds")
        VALUES ${insertValues}
        ON CONFLICT (key) DO UPDATE SET "users" = excluded."users", "lastTriggered" = NOW()
      `);
      await insertResp.result();
    }
  }
}

// --- read: base rows (unenriched) -------------------------------------------------------------------
export async function queryNotifications(input: {
  userId: number;
  limit: number;
  cursor?: Date;
  category?: NotificationCategory | null;
  unread?: boolean;
}): Promise<NotificationRow[]> {
  const { userId, limit, cursor, category, unread } = input;
  const where: string[] = ['un."userId" = $1'];
  const params: unknown[] = [userId];
  if (unread) where.push('un.viewed IS FALSE');
  if (category) {
    params.push(category);
    where.push(`n.category = $${params.length}::"NotificationCategory"`);
  }
  if (cursor) {
    params.push(cursor);
    where.push(`un."createdAt" < $${params.length}`);
  }
  params.push(limit);

  const db = await getNotifDbWithoutLag(userId);
  const query = await db.cancellableQuery<NotificationRow>(
    `SELECT un.id, n.type, n.category, n.details, un."createdAt", un.viewed AS read
     FROM "UserNotification" un
       JOIN "Notification" n ON n."id" = un."notificationId"
     WHERE ${where.join(' AND ')}
     ORDER BY un."createdAt" DESC
     LIMIT $${params.length}`,
    params
  );
  return await query.result();
}

// --- read: per-category counts (cache-fronted, lag-aware, single-flighted) --------------------------
// Per-key request coalescing (single-flight). The bell-count query is the heaviest read on the DB and,
// within a user's replication-lag window, busts the cache and hits the primary on EVERY call — so N
// concurrent count requests for the same (userId, unread, category) used to each launch the multi-second
// `GROUP BY category` scan (an observed 43-way thundering herd on one user). Here, if an identical call is
// already in flight we await ITS promise and return that result instead of launching another. On settle the
// entry is removed (finally) so the next call re-derives fresh cache/lag state. Correctness-neutral: same
// user + same params ⇒ same count, so sharing one execution and one result changes nothing observable.
//
// NOTE the semantic difference from markNotificationsRead's `userWriteQueues`: writes SERIALIZE (each
// enqueued onto the tail of the prior) because concurrent writes must not overlap; reads COALESCE (all
// awaiters share the ONE in-flight promise) because the result is identical and re-running is pure waste.
//
// Exported for test visibility only (like userWriteQueues) — not part of the public surface.
export const countInFlight = new Map<string, Promise<NotificationCategoryCount[]>>();

export function countNotifications(input: {
  userId: number;
  unread: boolean;
  category?: NotificationCategory | null;
}): Promise<NotificationCategoryCount[]> {
  const { userId, unread, category } = input;
  const key = `${userId}:${unread}:${category ?? 'all'}`;

  const existing = countInFlight.get(key);
  if (existing) return existing;

  const inFlight = countNotificationsImpl(input);
  countInFlight.set(key, inFlight);
  // Clean up on settle (success OR failure) so a rejection can't poison the key and the next call re-derives
  // fresh state. Guard on identity in case a later call already replaced this entry. The trailing .catch
  // swallows ONLY this cleanup chain's copy of a rejection (the real rejection still reaches the callers
  // awaiting `inFlight`); without it, the derived finally-promise would surface as an unhandled rejection.
  void inFlight
    .finally(() => {
      if (countInFlight.get(key) === inFlight) countInFlight.delete(key);
    })
    .catch(() => {});
  return inFlight;
}

async function countNotificationsImpl(input: {
  userId: number;
  unread: boolean;
  category?: NotificationCategory | null;
}): Promise<NotificationCategoryCount[]> {
  const { userId, unread, category } = input;

  // Check the lag flag BEFORE the cache — if a recent write flagged this user, bust the cache and read
  // the primary to avoid a stale count.
  const db = await getNotifDbWithoutLag(userId);
  if (isWritePool(db)) {
    await notificationCache.bustUser(userId);
  } else {
    const cached = await notificationCache.getUser(userId);
    if (cached) return cached;
  }

  const where: string[] = ['un."userId" = $1'];
  const params: unknown[] = [userId];
  if (unread) where.push('un.viewed IS FALSE');
  if (category) {
    params.push(category);
    where.push(`n.category = $${params.length}::"NotificationCategory"`);
  }
  const query = await db.cancellableQuery<NotificationCategoryCount>(
    `SELECT n.category, COUNT(*) AS count
     FROM "UserNotification" un
       JOIN "Notification" n ON n."id" = un."notificationId"
     WHERE ${where.join(' AND ')}
     GROUP BY category`,
    params
  );
  const result = await query.result();
  await notificationCache.setUser(userId, result);
  return result;
}

// --- exists: producer-side dedup --------------------------------------------------------------------
// Reads the replica (matches the monolith's original `notifDbRead`): this is a best-effort dedup, and a
// replica-lag false-negative only risks a duplicate PendingNotification, which the worker collapses via
// the UNIQUE Notification.key. No per-key lag flag exists to route on, so no primary read is warranted.
export async function notificationExists(key: string): Promise<boolean> {
  const query = await notifDbRead().cancellableQuery<{ exists: number }>(
    `SELECT 1 as exists FROM "Notification" WHERE key = $1`,
    [key]
  );
  return (await query.result()).length > 0;
}

// --- cleanup: batched delete of old UserNotification rows -------------------------------------------
export async function cleanupNotifications(before: Date): Promise<number> {
  const write = notifDbWrite();
  let deleted = 0;
  // Batch so a single DELETE can't hold a long lock / bloat WAL on a large sweep.
  for (;;) {
    const resp = await write.query(
      `DELETE FROM "UserNotification"
       WHERE id IN (SELECT id FROM "UserNotification" WHERE "createdAt" < $1 LIMIT 10000)`,
      [before.toISOString()]
    );
    const rows = resp.rowCount ?? 0;
    deleted += rows;
    if (rows === 0) break;
  }
  return deleted;
}

// --- mark read: per-user serialized + retried on transient pool-acquire errors ----------------------
// Exported for test visibility only: `markNotificationsRead` returns void, so the fire-and-forget
// per-user chain promise is otherwise unreachable and the serialization/retry behavior can't be awaited
// deterministically. Not part of the module's public surface — do not depend on it from app code.
export const userWriteQueues = new Map<number, Promise<void>>();

const TRANSIENT_WRITE_ERRORS = [
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'Disconnects client',
];
const MARK_READ_MAX_ATTEMPTS = 4;
const MARK_READ_BACKOFF_BASE_MS = 200;
const MARK_READ_BACKOFF_GROWTH = 3;
const MARK_READ_BACKOFF_JITTER_MS = 300;

function isTransientWriteError(err: unknown): boolean {
  return err instanceof Error && TRANSIENT_WRITE_ERRORS.some((m) => err.message.includes(m));
}

/**
 * Enqueue a mark-read. Chained onto any in-flight write for this user so we never run >1 concurrent
 * pool.connect() per user per pod (the rapid-click pool-starvation guard from the monolith). Resolves
 * once enqueued — the write itself is fire-and-forget, matching the optimistic UI.
 */
export function markNotificationsRead(input: MarkReadInput): void {
  const userId = input.userId;
  const all = input.all ?? false;
  const prev = userWriteQueues.get(userId) ?? Promise.resolve();
  const next = prev.then(() => runMarkReadWithRetry({ ...input, all }));
  userWriteQueues.set(userId, next);
  void next.finally(() => {
    if (userWriteQueues.get(userId) === next) userWriteQueues.delete(userId);
  });
}

async function runMarkReadWithRetry(
  input: MarkReadInput & { all: boolean }
): Promise<void> {
  const { userId, all, category } = input;
  for (let attempt = 1; attempt <= MARK_READ_MAX_ATTEMPTS; attempt++) {
    try {
      await markReadImpl(input);
      if (attempt > 1)
        logToAxiom({
          type: 'info',
          name: 'notification.markRead',
          message: `Marked notifications read after ${attempt} attempts`,
          outcome: 'retrySuccess',
          userId,
          all,
          category,
          attempt,
        }).catch(() => null);
      return;
    } catch (err) {
      const transient = isTransientWriteError(err);
      if (!transient || attempt === MARK_READ_MAX_ATTEMPTS) {
        logToAxiom({
          type: 'warning',
          name: 'notification.markRead',
          message: `Failed to mark notifications read`,
          outcome: transient ? 'retriesExhausted' : 'nonTransientError',
          error: safeError(err),
          userId,
          all,
          category,
          attempt,
        }).catch(() => null);
        return;
      }
      const backoff =
        MARK_READ_BACKOFF_BASE_MS * MARK_READ_BACKOFF_GROWTH ** (attempt - 1) +
        Math.random() * MARK_READ_BACKOFF_JITTER_MS;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

async function markReadImpl(input: MarkReadInput & { all: boolean }): Promise<void> {
  const { id, userId, all, category } = input;
  const write = notifDbWrite();

  if (all) {
    if (category) {
      await write.query(
        `UPDATE "UserNotification" un SET viewed = TRUE
         FROM "Notification" n
         WHERE un."notificationId" = n.id AND un."userId" = $1 AND un.viewed IS FALSE
           AND n."category" = $2::"NotificationCategory"`,
        [userId, category]
      );
      await preventReplicationLag(userId);
      notificationCache.clearCategory(userId, category).catch(() => null);
    } else {
      await write.query(
        `UPDATE "UserNotification" un SET viewed = TRUE WHERE un."userId" = $1 AND un.viewed IS FALSE`,
        [userId]
      );
      await preventReplicationLag(userId);
      notificationCache.bustUser(userId).catch(() => null);
    }
    return;
  }

  const resp = await write.query(
    `UPDATE "UserNotification" un SET viewed = TRUE WHERE id = $1 AND viewed IS FALSE`,
    [id]
  );
  if (resp.rowCount) {
    await preventReplicationLag(userId);
    const db = await getNotifDbWithoutLag(userId);
    const catQuery = await db.cancellableQuery<{ category: NotificationCategory }>(
      `SELECT n.category FROM "UserNotification" un
         JOIN "Notification" n ON un."notificationId" = n.id
       WHERE un.id = $1`,
      [id]
    );
    const catData = await catQuery.result();
    if (catData.length) notificationCache.decrementUser(userId, catData[0].category).catch(() => null);
  }
}
