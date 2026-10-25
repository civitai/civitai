import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { notificationEmail } from '~/server/email/templates/notification.email';
import { logToAxiom } from '~/server/logging/client';
import type { BareNotification } from '~/server/notifications/base.notifications';
import { populateNotificationDetails } from '~/server/notifications/detail-fetchers';
import {
  getNotificationMessage,
  isEmailNotificationType,
  notificationProcessors,
} from '~/server/notifications/utils.notifications';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { createTtlMemo } from '~/server/utils/ttl-memoize';
import { getBaseUrl } from '~/server/utils/url-helpers';

/** `KeyValue` row that turns notification email on. Anything but JSON `true` leaves it off. */
export const NOTIFICATION_EMAIL_ENABLED_KEY = 'notification-email-enabled';
export const NOTIFICATION_EMAIL_USER_DAILY_CAP = 20;
export const NOTIFICATION_EMAIL_TYPE_HOURLY_CAP = 500;

const enabledMemo = createTtlMemo(async () => {
  const row = await dbRead.keyValue.findUnique({ where: { key: NOTIFICATION_EMAIL_ENABLED_KEY } });
  return row?.value === true;
}, 60 * 1000);

export async function isNotificationEmailEnabled() {
  try {
    return await enabledMemo();
  } catch {
    return false;
  }
}
export const clearNotificationEmailEnabledCache = () => enabledMemo.clear();

const signature = (userId: number, type: string) =>
  createHmac('sha256', env.NEXTAUTH_SECRET)
    .update(`notification-email-unsubscribe:${userId}:${type}`)
    .digest('hex')
    .slice(0, 32);

export function getEmailUnsubscribeUrl(userId: number, type: string) {
  const params = new URLSearchParams({ u: String(userId), t: type, s: signature(userId, type) });
  return `${getBaseUrl()}/api/notifications/email-unsubscribe?${params}`;
}

export function verifyEmailUnsubscribe(userId: number, type: string, sig: string) {
  const expected = Buffer.from(signature(userId, type));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export async function optOutOfNotificationEmail(userId: number, type: string) {
  await dbWrite.$executeRaw`
    INSERT INTO "UserEmailNotificationOptOut" ("userId", "type")
    SELECT ${userId}, ${type}
    WHERE EXISTS (SELECT 1 FROM "User" WHERE id = ${userId})
    ON CONFLICT DO NOTHING`;
}

/** INCR with a first-hit expiry. Throws on a Redis error: callers fail closed. */
async function bump(key: `${string}:${string}`, ttlSeconds: number) {
  const count = await sysRedis.incrBy(key as never, 1);
  if (count === 1) await sysRedis.expire(key as never, ttlSeconds);
  return count;
}

/** False once the type has sent its hourly ceiling; logs the trip once per hour. */
async function underTypeCap(type: string) {
  const hour = new Date().toISOString().slice(0, 13);
  const count = await bump(
    `${REDIS_SYS_KEYS.SYSTEM.NOTIFICATION_EMAIL_TYPE_QUOTA}:${type}:${hour}`,
    60 * 60 * 2
  );
  if (count === NOTIFICATION_EMAIL_TYPE_HOURLY_CAP + 1)
    logToAxiom({
      name: 'notification-email',
      type: 'error',
      message: 'per-type hourly email cap tripped; sending stopped for the rest of the hour',
      notificationType: type,
    }).catch(() => null);
  return count <= NOTIFICATION_EMAIL_TYPE_HOURLY_CAP;
}

async function underUserCap(userId: number) {
  const day = new Date().toISOString().slice(0, 10);
  const count = await bump(
    `${REDIS_SYS_KEYS.SYSTEM.NOTIFICATION_EMAIL_USER_QUOTA}:${userId}:${day}`,
    60 * 60 * 48
  );
  return count <= NOTIFICATION_EMAIL_USER_DAILY_CAP;
}

type Recipient = { id: number; email: string };

export type NotificationEmailOutcome = {
  sent: number;
  skipped: 'disabled' | 'not-email-type' | 'unrenderable' | null;
  capped: number;
  failed: number;
};

/**
 * Emails one fanned-out notification to the recipients who get email for its type. Called by the
 * fan-out worker with the users the notification was newly delivered to, so a repeated key has
 * already been reduced to nobody. Redis down → nothing is sent: a flood is worse than a gap, and
 * the bell still carries the notification.
 */
export async function sendNotificationEmails({
  type,
  details,
  userIds,
}: {
  type: string;
  details: Record<string, unknown>;
  userIds: number[];
}): Promise<NotificationEmailOutcome> {
  const outcome: NotificationEmailOutcome = { sent: 0, skipped: null, capped: 0, failed: 0 };
  if (!isEmailNotificationType(type)) return { ...outcome, skipped: 'not-email-type' };
  if (!(await isNotificationEmailEnabled())) return { ...outcome, skipped: 'disabled' };
  if (userIds.length === 0) return outcome;

  const [bare]: BareNotification[] = [{ id: 0, type, details }];
  await populateNotificationDetails([bare]);
  const prepared = getNotificationMessage(bare);
  if (!prepared?.message) return { ...outcome, skipped: 'unrenderable' };
  const typeName = notificationProcessors[type]?.displayName ?? 'Civitai';

  const recipients = await dbRead.$queryRaw<Recipient[]>`
    SELECT u.id, u.email
    FROM "User" u
    WHERE u.id = ANY(${userIds}::int[])
      AND u.email IS NOT NULL
      AND u."deletedAt" IS NULL
      AND u."bannedAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "UserEmailNotificationOptOut" o WHERE o."userId" = u.id AND o."type" = ${type}
      )`;

  for (const recipient of recipients) {
    try {
      if (!(await underTypeCap(type)) || !(await underUserCap(recipient.id))) {
        outcome.capped++;
        continue;
      }
      await notificationEmail.send({
        to: recipient.email,
        typeName,
        message: prepared.message,
        url: prepared.url,
        unsubscribeUrl: getEmailUnsubscribeUrl(recipient.id, type),
      });
      outcome.sent++;
    } catch (error) {
      outcome.failed++;
      logToAxiom({
        name: 'notification-email',
        type: 'error',
        message: 'notification email could not be sent',
        notificationType: type,
        error: (error as Error)?.message,
      }).catch(() => null);
    }
  }
  return outcome;
}
