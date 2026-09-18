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
      .map((d) => format('(%L, %L, %L)', d.key, `{${d.users.join(',')}}`, d.dedupeKey ?? null))
      .join(',');
    // COALESCE, not a bare assign: the queued row may predate this column (a pending row written by the
    // previous build carries NULL), and re-claiming it here is what keeps that deploy window deduped.
    // An existing key is never overwritten — the same `key` always implies the same source event.
    const updateResp = await write.cancellableQuery<{ key: string }>(`
      UPDATE "PendingNotification" pn
      SET "users" = ARRAY(SELECT DISTINCT unnest(pn."users" || u.users::int[])),
          "lastTriggered" = NOW(),
          "dedupeKey" = COALESCE(pn."dedupeKey", u."dedupeKey")
      FROM (VALUES ${updateValues}) AS u(key, users, "dedupeKey")
      WHERE pn."key" = u.key
      RETURNING pn."key"
    `);
    const updated = new Set((await updateResp.result()).map((r) => r.key));

    const toInsert = batch.filter((d) => !updated.has(d.key));
    if (toInsert.length) {
      const insertValues = toInsert
        .map((d) =>
          format(
            '(%L, %L, %L::"NotificationCategory", %L, %L::jsonb, %L, %L)',
            d.key,
            d.type,
            d.category,
            `{${d.users.join(',')}}`,
            JSON.stringify(d.details),
            d.debounceSeconds ?? null,
            d.dedupeKey ?? null
          )
        )
        .join(',');
      const insertResp = await write.cancellableQuery(`
        INSERT INTO "PendingNotification" (key, type, category, users, details, "debounceSeconds", "dedupeKey")
        VALUES ${insertValues}
        ON CONFLICT (key) DO UPDATE SET "users" = ARRAY(SELECT DISTINCT unnest("PendingNotification"."users" || excluded."users")), "lastTriggered" = NOW()
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
// entry is removed (finally) so the next call re-derives fresh cache/lag state.
//
// NOT strictly correctness-neutral: countNotificationsImpl's result also depends on the lag-flag state AT
// EXECUTION time (replica vs primary read via getNotifDbWithoutLag), which the (userId, unread, category)
// key does not capture. If a mark-read lands DURING an in-flight replica read, a caller that arrives after
// the write and coalesces gets the pre-write (replica) count instead of its own fresh primary read. This is
// bounded and self-healing: mark-read busts the cache so the next poll re-queries; the staleness lasts at
// most one in-flight-query duration; and the client already optimistically decremented, so the badge shows
// the right number regardless. We deliberately do NOT gate coalescing on the lag flag — that check is async
// (Redis), which would reintroduce the TOCTOU race the synchronous set() below avoids, and recent-writers
// are exactly the herd single-flight most needs to collapse.
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

  // The count cache (cache.ts) is a SINGLE per-user redis hash of per-category UNREAD counts, maintained
  // incrementally by the worker's incrementUser (fan-out) / decrementUser (mark-read). It is keyed on
  // `userId` ONLY — it does not distinguish the `unread` flag or a `category` filter. So it can correctly
  // represent EXACTLY ONE variant of this query: `unread:true` with no category. For any other variant:
  //   - `unread:false` (totals incl. read): there is no worker-maintained "total" counter, so this is
  //     fundamentally uncacheable in this structure — and writing a total into the hash would CORRUPT the
  //     worker's unread counters for every subsequent read.
  //   - a `category`-scoped call: getUser returns the ALL-category hash, not the requested subset.
  // Therefore gate the ENTIRE cache interaction (read + recent-writer bust + populate) on the cacheable
  // variant. Non-cacheable variants touch the cache NOT AT ALL and just run the DB query uncached —
  // getNotifDbWithoutLag still routes recent-writers to the primary, so freshness is preserved.
  const cacheable = unread === true && category == null;

  // Check the lag flag BEFORE the cache — if a recent write flagged this user, bust the cache and read
  // the primary to avoid a stale count. Only the cacheable variant interacts with the cache at all.
  const db = await getNotifDbWithoutLag(userId);
  if (cacheable) {
    if (isWritePool(db)) {
      await notificationCache.bustUser(userId);
    } else {
      const cached = await notificationCache.getUser(userId);
      if (cached) return cached;
    }
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
  if (cacheable) await notificationCache.setUser(userId, result);
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
const CLEANUP_BATCH_SIZE = 10000;
// Users busted in parallel per batch, at two redis round-trips each (lag flag + DEL). Most rows in a
// batch belong to a different user, so this is the knob that decides whether the bust side dominates
// the sweep's wall clock.
const CLEANUP_BUST_CONCURRENCY = 25;

type DeletedRow = { userId: number; viewed: boolean };

export async function cleanupNotifications(before: Date): Promise<number> {
  const write = notifDbWrite();
  let deleted = 0;
  let busted = 0;
  // Batch so a single DELETE can't hold a long lock / bloat WAL on a large sweep.
  for (;;) {
    const resp = await write.query<DeletedRow>(
      `DELETE FROM "UserNotification"
       WHERE id IN (SELECT id FROM "UserNotification" WHERE "createdAt" < $1 LIMIT ${CLEANUP_BATCH_SIZE})
       RETURNING "userId", viewed`,
      [before.toISOString()]
    );
    deleted += resp.rows.length;
    if (resp.rows.length === 0) break;
    busted += await bustDeletedUnreadCounts(resp.rows);
  }
  logToAxiom({
    type: 'info',
    name: 'notification.cleanup',
    message: `Cleaned up notifications older than ${before.toISOString()}`,
    deleted,
    busted,
  }).catch(() => null);
  return deleted;
}

/**
 * Drop the cached unread counts of every user this batch deleted an UNREAD row from, or the cache
 * outlives its rows for a week — the badge keeps counting notifications the list can no longer show.
 *
 * Only unread rows matter: the hash counts `viewed IS FALSE` rows ONLY (see countNotificationsImpl),
 * so deleting a read row cannot make it wrong. bustUser rather than decrementUser — the next count
 * re-derives from the DB, so a bust cannot drift the way an arithmetic adjustment can.
 *
 * Both redis calls swallow their errors: a redis outage must not abort a delete sweep that is doing
 * its real work against postgres. The sweep log carries the attempted/succeeded split so the swallow
 * is visible afterwards.
 *
 * Flag the lag window BEFORE busting, exactly as markReadImpl does. A count that picks its pool AFTER
 * the flag reads the primary, so it cannot re-cache the rows this batch just deleted. It does NOT save
 * a count already in flight against the replica: that one selected its pool before the flag existed and
 * will still setUser a pre-delete number for the full week — the same exposure mark-read carries, and
 * the reason this is a narrowing rather than a closure. The flag costs nothing when
 * REPLICATION_LAG_DELAY is unset — createLagTracker no-ops a non-positive delay.
 */
async function bustDeletedUnreadCounts(rows: DeletedRow[]): Promise<number> {
  const userIds: number[] = [];
  const seen = new Set<number>();
  for (const { userId, viewed } of rows) {
    if (viewed || seen.has(userId)) continue;
    seen.add(userId);
    userIds.push(userId);
  }

  let next = 0;
  // Counts keys actually dropped, not users attempted: both redis calls swallow their errors, so an
  // attempt count would report a full sweep's worth of busts through a redis outage that dropped none.
  let busted = 0;
  const workers = Array.from({ length: Math.min(CLEANUP_BUST_CONCURRENCY, userIds.length) }, () =>
    (async () => {
      for (let i = next++; i < userIds.length; i = next++) {
        const userId = userIds[i];
        await preventReplicationLag(userId).catch(() => null);
        const ok = await notificationCache
          .bustUser(userId)
          .then(() => true)
          .catch(() => false);
        if (ok) busted++;
      }
    })()
  );
  await Promise.all(workers);
  return busted;
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

async function runMarkReadWithRetry(input: MarkReadInput & { all: boolean }): Promise<void> {
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
    if (catData.length)
      notificationCache.decrementUser(userId, catData[0].category).catch(() => null);
  }
}
