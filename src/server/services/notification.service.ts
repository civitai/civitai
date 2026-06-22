import { Prisma } from '@prisma/client';
import * as z from 'zod';
import type { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { getNotifDbWithoutLag, preventReplicationLag } from '~/server/db/db-lag-helpers';
import { notifDbRead, notifDbWrite } from '~/server/db/notifDb';
import { logToAxiom, safeError } from '~/server/logging/client';
import { populateNotificationDetails } from '~/server/notifications/detail-fetchers';
import type { NotificationCategoryCount } from '~/server/notifications/notification-cache';
import { notificationCache } from '~/server/notifications/notification-cache';
import {
  notificationSingleRowFull,
  type GetUserNotificationsSchema,
  type MarkReadNotificationInput,
  type ToggleNotificationSettingInput,
} from '~/server/schema/notification.schema';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

type NotificationsRaw = {
  id: number;
  type: string;
  category: NotificationCategory;
  details: MixedObject;
  createdAt: Date;
  read: boolean;
};

export const createNotificationPendingRow = notificationSingleRowFull
  .omit({ userId: true })
  .extend({
    userId: z.number().optional(),
    userIds: z.array(z.number()).optional(),
    debounceSeconds: z.number().optional(),
  });
export type CreateNotificationPendingRow = z.infer<typeof createNotificationPendingRow>;

export const createNotification = async (data: CreateNotificationPendingRow) => {
  try {
    if (!data.userIds) data.userIds = [];
    if (data.userId) data.userIds.push(data.userId);
    if (data.userIds.length === 0) return;

    const userNotificationSettings = await dbRead.userNotificationSettings.findMany({
      where: { userId: { in: data.userIds }, type: data.type },
    });
    // TODO handle defaultDisabled
    const targets = data.userIds.filter(
      (x) => !userNotificationSettings.some((y) => y.userId === x) && x !== -1
    );
    // If the user has this notification type disabled, don't create a notification.
    if (targets.length === 0) return;

    // UPDATE-first to avoid burning a sequence id when the key already exists.
    // INSERT ... ON CONFLICT (key) DO UPDATE in the fallback handles the cross-writer race
    // where another writer inserts the same key between our UPDATE and INSERT.
    const updateResp = await notifDbWrite.cancellableQuery<{ id: number }>(Prisma.sql`
      UPDATE "PendingNotification"
      SET "users" = ${'{' + targets.join(',') + '}'}::int[],
          "lastTriggered" = NOW()
      WHERE "key" = ${data.key}
      RETURNING id
    `);
    const updated = await updateResp.result();

    if (updated.length === 0) {
      const insertResp = await notifDbWrite.cancellableQuery(Prisma.sql`
        INSERT INTO "PendingNotification" (key, type, category, users, details, "debounceSeconds")
        VALUES (
          ${data.key},
          ${data.type},
          ${data.category}::"NotificationCategory",
          ${'{' + targets.join(',') + '}'},
          ${JSON.stringify(data.details)}::jsonb,
          ${data.debounceSeconds}
        )
        ON CONFLICT (key)
        DO UPDATE SET "users" = excluded."users", "lastTriggered" = NOW()
      `);
      await insertResp.result();
    }
  } catch (e) {
    const error = e as Error;
    logToAxiom(
      {
        type: 'warning',
        name: 'Failed to create notification',
        details: { key: data.key },
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      },
      'notifications'
    ).catch();
  }
};

export async function getUserNotifications({
  limit = DEFAULT_PAGE_SIZE,
  cursor,
  userId,
  category,
  count = false,
  unread = false,
}: Partial<GetUserNotificationsSchema> & {
  userId: number;
  count?: boolean;
}) {
  const AND = [Prisma.sql`un."userId" = ${userId}`];
  if (unread) AND.push(Prisma.sql`un.viewed IS FALSE`);
  if (category) AND.push(Prisma.sql`n.category = ${category}::"NotificationCategory"`);

  if (cursor) AND.push(Prisma.sql`un."createdAt" < ${cursor}`);
  // else AND.push(Prisma.sql`un."createdAt" > NOW() - interval '1 month'`);

  const db = await getNotifDbWithoutLag('notification', userId);
  const query = await db.cancellableQuery<NotificationsRaw>(Prisma.sql`
    SELECT
      un.id,
      n.type,
      n.category,
      n.details,
      un."createdAt",
      un.viewed AS read
    FROM
      "UserNotification" un
        JOIN "Notification" n ON n."id" = un."notificationId"
    WHERE
      ${Prisma.join(AND, ' AND ')}
    ORDER BY un."createdAt" DESC
    LIMIT ${limit}
  `);
  const items = await query.result();

  await populateNotificationDetails(items);

  if (count) return { items, count: await getUserNotificationCount({ userId, unread }) };

  return { items };
}

export async function getUserNotificationCount({
  userId,
  unread,
  category,
}: {
  userId: number;
  unread: boolean;
  category?: NotificationCategory;
}) {
  // Check lag key BEFORE cache — if a recent write is flagged for this user,
  // bust the cache and query the primary to avoid returning stale counts.
  const db = await getNotifDbWithoutLag('notification', userId);
  if (db === notifDbWrite) {
    await notificationCache.bustUser(userId);
  } else {
    const cachedCount = await notificationCache.getUser(userId);
    if (cachedCount) return cachedCount;
  }

  const AND = [Prisma.sql`un."userId" = ${userId}`];
  if (unread) AND.push(Prisma.sql`un.viewed IS FALSE`);

  if (category) AND.push(Prisma.sql`n.category = ${category}::"NotificationCategory"`);
  const query = await db.cancellableQuery<NotificationCategoryCount>(Prisma.sql`
    SELECT
      n.category,
      COUNT(*) AS count
    FROM
      "UserNotification" un
        JOIN "Notification" n ON n."id" = un."notificationId"
    WHERE
      ${Prisma.join(AND, ' AND ')}
    GROUP BY category
  `);

  const result = await query.result();
  await notificationCache.setUser(userId, result);
  return result;
}

// Per-user serialization queue. Rapid-click streams previously fanned out to
// N concurrent pool.connect() acquisitions against the notif pool, which
// starved it under load (46k "Connection terminated due to connection timeout"
// warnings / week). Serializing per user caps in-flight writes to 1 per
// active user without blocking the handler.
const userWriteQueues = new Map<number, Promise<void>>();

// Transient pg pool-acquire errors. These routinely succeed on retry once the
// pool has a free slot; other errors are not retried.
const TRANSIENT_WRITE_ERRORS = [
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'Disconnects client',
];

// Retry tuning. Each pg pool.connect() itself waits up to ~5s, so combined
// with these backoffs the full retry window spans ~15-20s — enough to
// outlast a typical pool-saturation burst without hammering a stuck pool.
// Backoff schedule: ~200-500ms, ~600-900ms, ~1800-2100ms between attempts.
const MARK_READ_MAX_ATTEMPTS = 4;
const MARK_READ_BACKOFF_BASE_MS = 200;
const MARK_READ_BACKOFF_GROWTH = 3;
const MARK_READ_BACKOFF_JITTER_MS = 300;

function isTransientWriteError(err: unknown): boolean {
  return err instanceof Error && TRANSIENT_WRITE_ERRORS.some((msg) => err.message.includes(msg));
}

// Runs the write with bounded retries on transient pool-acquire errors.
// Always resolves without surfacing errors upward because the UI is already
// optimistic. Emits a `notification.markRead` Axiom event only for retry
// success (`outcome: retrySuccess`) or terminal failure
// (`outcome: retriesExhausted` / `nonTransientError`); first-attempt success
// does not log an event.
async function runMarkReadWithRetry(
  input: MarkReadNotificationInput & { userId: number; all: boolean }
): Promise<void> {
  const { userId, all, category } = input;
  for (let attempt = 1; attempt <= MARK_READ_MAX_ATTEMPTS; attempt++) {
    try {
      await _markNotificationsReadImpl(input);
      if (attempt > 1) {
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
      }
      return;
    } catch (err) {
      const transient = isTransientWriteError(err);
      if (!transient || attempt === MARK_READ_MAX_ATTEMPTS) {
        const errMessage = err instanceof Error ? err.message : String(err);
        logToAxiom({
          type: 'warning',
          name: 'notification.markRead',
          message: `Failed to mark notifications read: ${errMessage}`,
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

export const markNotificationsRead = async ({
  id,
  userId,
  all = false,
  category,
}: MarkReadNotificationInput & { userId: number }) => {
  // Fire-and-forget: the UI optimistically marks as read, so we don't block
  // on the cross-Atlantic write. Chained onto any in-flight write for this
  // user so we never run >1 concurrent pool.connect() per user per pod.
  const prev = userWriteQueues.get(userId) ?? Promise.resolve();
  const next = prev.then(() => runMarkReadWithRetry({ id, userId, all, category }));
  userWriteQueues.set(userId, next);
  next.finally(() => {
    // Only drop from the map if we're still the tail — a newer call may have
    // taken our slot, in which case it owns the cleanup.
    if (userWriteQueues.get(userId) === next) userWriteQueues.delete(userId);
  });
};

async function _markNotificationsReadImpl({
  id,
  userId,
  all,
  category,
}: MarkReadNotificationInput & { userId: number; all: boolean }) {
  if (all) {
    if (category) {
      // Join only needed when filtering by category
      await notifDbWrite.query(Prisma.sql`
        UPDATE "UserNotification" un
        SET
          viewed = TRUE
        FROM
          "Notification" n
        WHERE
          un."notificationId" = n.id
          AND un."userId" = ${userId}
          AND un.viewed IS FALSE
          AND n."category" = ${category}::"NotificationCategory"
      `);
      await preventReplicationLag('notification', userId);
      notificationCache.clearCategory(userId, category).catch(() => null);
    } else {
      // No join needed - faster query
      await notifDbWrite.query(Prisma.sql`
        UPDATE "UserNotification" un
        SET
          viewed = TRUE
        WHERE
          un."userId" = ${userId}
          AND un.viewed IS FALSE
      `);
      await preventReplicationLag('notification', userId);
      notificationCache.bustUser(userId).catch(() => null);
    }
  } else {
    const resp = await notifDbWrite.query(Prisma.sql`
      UPDATE "UserNotification" un
      SET
        viewed = TRUE
      WHERE
          id = ${id}
      AND viewed IS FALSE
    `);
    if (resp.rowCount) await preventReplicationLag('notification', userId);

    // Update cache if the notification was marked read
    if (resp.rowCount) {
      const db = await getNotifDbWithoutLag('notification', userId);
      const catQuery = await db.cancellableQuery<{
        category: NotificationCategory;
      }>(Prisma.sql`
        SELECT
          n.category
        FROM
          "UserNotification" un
            JOIN "Notification" n ON un."notificationId" = n.id
        WHERE
          un.id = ${id}
      `);
      const catData = await catQuery.result();
      if (catData && catData.length)
        notificationCache.decrementUser(userId, catData[0].category).catch(() => null);
    }
  }
}

export const createUserNotificationSetting = async ({
  type,
  userId,
}: ToggleNotificationSettingInput & { userId: number }) => {
  const values = type.map((t) => Prisma.sql`(${t}, ${userId})`);
  return dbWrite.$executeRaw`
    INSERT INTO "UserNotificationSettings" ("type", "userId")
    VALUES
    ${Prisma.join(values)}
    ON CONFLICT
    DO NOTHING
  `;
};

export const deleteUserNotificationSetting = async ({
  type,
  userId,
}: ToggleNotificationSettingInput & { userId: number }) => {
  return dbWrite.userNotificationSettings.deleteMany({ where: { type: { in: type }, userId } });
};
