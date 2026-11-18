import { sql, type Kysely } from 'kysely';
import { NOTICE_MIN_INTERVAL_MS, withThrottleRetry, type Sleep } from '@civitai/email';
import type { UnseenNotifications } from '@civitai/notifications';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { dbKV } from '~/server/db/db-helpers';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import {
  missedNotificationsDigestEmail,
  type MissedNotificationsDigestItem,
} from '~/server/email/templates/missedNotificationsDigest.email';
import { logToAxiom } from '~/server/logging/client';
import type { BareNotification } from '~/server/notifications/base.notifications';
import { notifications } from '~/server/notifications/client';
import { populateNotificationDetails } from '~/server/notifications/detail-fetchers';
import { MISSED_DIGEST_EMAIL_TYPE } from '~/server/notifications/missed-digest.constants';
import {
  silenceCheckTypeAges,
  silencedUsersAmong,
} from '~/server/notifications/silence-check-ages';
import {
  emailNotificationTypeList,
  getNotificationMessage,
  silenceCheckTypes,
} from '~/server/notifications/utils.notifications';
import {
  getEmailUnsubscribeUrl,
  isNotificationEmailEnabled,
} from '~/server/services/notification-email.service';
import { sleep as realSleep } from '~/server/utils/concurrency-helpers';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A digest lists what the user has not seen in this window (or since their last digest, if later). */
export const DIGEST_WINDOW_MS = 7 * DAY_MS;
/** A user sent a digest this recently is skipped, so a user gets at most one per weekly pass. */
export const DIGEST_MIN_GAP_MS = 6 * DAY_MS;
/** A pass over every user starts at most this often. */
export const DIGEST_CYCLE_MS = 7 * DAY_MS;
/** Notifications listed in one email; the rest are "and N more". */
export const DIGEST_ITEM_LIMIT = 10;
/** Users read per main-DB page and per notifications-app call. */
export const DIGEST_USER_BATCH = 1000;
/** One run stops after this long, or this many sends; the next scheduled run carries on. */
export const DIGEST_RUN_BUDGET_MS = 40 * 60 * 1000;
export const DIGEST_MAX_SENDS_PER_RUN = 4000;
/** KeyValue row holding where the current pass has reached. */
export const DIGEST_CURSOR_KEY = 'missed-notification-digest:cursor';

export type DigestCursor = { cycleStartedAt: string; lastUserId: number; done: boolean };

export const digestSkipReasons = [
  'no-verified-email',
  'opted-out',
  'not-in-rollout',
  'all-notifications-off',
  'recently-sent',
  'none-unseen',
  'unrenderable',
] as const;
export type DigestSkipReason = (typeof digestSkipReasons)[number];

export type DigestRunResult = {
  /** Why the run did nothing at all, if it did nothing. */
  idle: 'email-disabled' | 'cycle-done' | 'table-missing' | null;
  /** Users read this run (not deleted, not banned). */
  considered: number;
  emailed: number;
  failed: number;
  skipped: Record<DigestSkipReason, number>;
  /** Why the run stopped before the end of the pass. */
  stopped: 'budget' | 'send-cap' | 'email-disabled' | null;
  /** True when this run finished the pass. */
  cycleDone: boolean;
};

type Candidate = {
  id: number;
  email: string | null;
  hasEmail: boolean;
  optedOut: boolean;
  lastSentAt: Date | null;
};

export type DigestDeps = {
  now?: () => Date;
  sleep?: Sleep;
  minIntervalMs?: number;
  budgetMs?: number;
  maxSends?: number;
  batchSize?: number;
  read?: Kysely<DB>;
  write?: Kysely<DB>;
  checkIfCanceled?: () => void;
  /** Whether this user is in the digest's rollout: the Flipt flag, evaluated per user. */
  inRollout?: (userId: number) => Promise<boolean>;
  /** The notification-email kill switch (KeyValue `notification-email-enabled`). */
  emailEnabled?: () => Promise<boolean>;
};

const UNDEFINED_TABLE = '42P01';
const isUndefinedTable = (e: unknown) => (e as { code?: string } | null)?.code === UNDEFINED_TABLE;

/** One page of users after `afterId`, with what decides whether they can be emailed at all. */
async function readCandidates(db: Kysely<DB>, afterId: number, limit: number) {
  const { rows } = await sql<Candidate>`
    SELECT u.id, u.email,
      (u.email IS NOT NULL AND u."emailVerified" IS NOT NULL) AS "hasEmail",
      EXISTS (
        SELECT 1 FROM "UserEmailNotificationOptOut" o
        WHERE o."userId" = u.id AND o."type" = ${MISSED_DIGEST_EMAIL_TYPE}
      ) AS "optedOut",
      d."lastSentAt"
    FROM "User" u
    LEFT JOIN "UserNotificationDigest" d ON d."userId" = u.id
    WHERE u.id > ${afterId} AND u."deletedAt" IS NULL AND u."bannedAt" IS NULL
    ORDER BY u.id
    LIMIT ${limit}`.execute(db);
  return rows;
}

/** The opt-out read on the primary, so one written since the replica read already holds. */
async function optedOutOnPrimary(db: Kysely<DB>, userId: number) {
  const { rows } = await sql<{ one: number }>`
    SELECT 1 AS one FROM "UserEmailNotificationOptOut"
    WHERE "userId" = ${userId} AND "type" = ${MISSED_DIGEST_EMAIL_TYPE}`.execute(db);
  return rows.length > 0;
}

async function recordSent(db: Kysely<DB>, userId: number, at: Date) {
  await sql`
    INSERT INTO "UserNotificationDigest" ("userId", "lastSentAt") VALUES (${userId}, ${utc(at)})
    ON CONFLICT ("userId") DO UPDATE SET "lastSentAt" = excluded."lastSentAt"`.execute(db);
}

/** Puts back what the row held before a send that failed, so the next pass tries the user again. */
async function unrecordSent(db: Kysely<DB>, userId: number, previous: Date | null) {
  if (previous)
    await sql`UPDATE "UserNotificationDigest" SET "lastSentAt" = ${utc(
      previous
    )} WHERE "userId" = ${userId}`.execute(db);
  else await sql`DELETE FROM "UserNotificationDigest" WHERE "userId" = ${userId}`.execute(db);
}

/** The listed lines, rendered the way the bell renders them; a type with no message is left out. */
async function renderItems(user: UnseenNotifications): Promise<MissedNotificationsDigestItem[]> {
  const bare: BareNotification[] = user.items.map((item) => ({
    id: item.id,
    type: item.type,
    details: { ...item.details },
  }));
  await populateNotificationDetails(bare, { showSfwFace: true });
  const items: MissedNotificationsDigestItem[] = [];
  for (const notification of bare) {
    const prepared = getNotificationMessage(notification);
    if (prepared?.message) items.push({ message: prepared.message, url: prepared.url });
  }
  return items;
}

/**
 * One run of the weekly missed-notification digest. Walks every user in id order, a page at a
 * time, resuming where the last run stopped; a new pass starts once the last one has finished and
 * a week has passed since it started.
 *
 * Who is emailed: a user with a verified email, who has not opted out of the digest, is in the
 * flag's rollout (evaluated per user, so a percentage rollout ramps it), has not turned
 * every notification off, was not sent a digest in the last six days, and has at least one
 * notification they have not seen in the window. Types that send their own email when they happen
 * (`defaultEmail`) are left out of both the list and the count, so the digest never repeats one.
 *
 * Each send is recorded in `UserNotificationDigest` BEFORE the email goes out, so a run that dies
 * mid-send can skip a user's digest for the week but never send it twice. Sends are spaced by
 * `minIntervalMs` (the shared bulk-email pace) and capped per run.
 *
 * Two stops: the Flipt flag, and the notification-email kill switch shared with the
 * per-notification emails. The switch is read before the run and again before every send, so
 * turning it off stops a run within the switch's cache lifetime.
 */
export async function runMissedNotificationDigest(deps: DigestDeps = {}): Promise<DigestRunResult> {
  const {
    now = () => new Date(),
    sleep = realSleep,
    minIntervalMs = NOTICE_MIN_INTERVAL_MS,
    budgetMs = DIGEST_RUN_BUDGET_MS,
    maxSends = DIGEST_MAX_SENDS_PER_RUN,
    batchSize = DIGEST_USER_BATCH,
    read = kyselyRead,
    write = kyselyWrite,
    checkIfCanceled = () => undefined,
    inRollout = (userId: number) =>
      isFlipt(FLIPT_FEATURE_FLAGS.MISSED_NOTIFICATION_DIGEST, String(userId)),
    emailEnabled = isNotificationEmailEnabled,
  } = deps;
  const result: DigestRunResult = {
    idle: null,
    considered: 0,
    emailed: 0,
    failed: 0,
    skipped: Object.fromEntries(digestSkipReasons.map((r) => [r, 0])) as DigestRunResult['skipped'],
    stopped: null,
    cycleDone: false,
  };
  const startedAt = now().getTime();

  if (!(await emailEnabled())) return { ...result, idle: 'email-disabled' };

  let cursor = await dbKV.get<DigestCursor>(DIGEST_CURSOR_KEY);
  if (!cursor || cursor.done) {
    if (cursor && startedAt - new Date(cursor.cycleStartedAt).getTime() < DIGEST_CYCLE_MS)
      return { ...result, idle: 'cycle-done' };
    cursor = { cycleStartedAt: new Date(startedAt).toISOString(), lastUserId: 0, done: false };
  }

  try {
    await sql`SELECT 1 FROM "UserNotificationDigest" LIMIT 1`.execute(write);
  } catch (e) {
    if (isUndefinedTable(e)) return { ...result, idle: 'table-missing' };
    throw e;
  }

  const silenceTypes = await silenceCheckTypeAges(silenceCheckTypes);
  let nextSendAt = 0;
  const pace = async () => {
    const at = now().getTime();
    const start = Math.max(at, nextSendAt);
    nextSendAt = start + minIntervalMs;
    if (start > at) await sleep(start - at);
  };
  const outOfBudget = () => {
    if (result.emailed + result.failed >= maxSends) return 'send-cap' as const;
    if (now().getTime() - startedAt >= budgetMs) return 'budget' as const;
    return null;
  };

  try {
    pages: for (;;) {
      checkIfCanceled();
      // Also checked here, not only before a send: a run of pages with nobody eligible on them
      // (the whole table, while the flag is off) would otherwise never stop for the budget.
      const pageStop = outOfBudget();
      if (pageStop) {
        result.stopped = pageStop;
        break;
      }
      const page = await readCandidates(read, cursor.lastUserId, batchSize);
      result.considered += page.length;

      const reachable: Candidate[] = [];
      for (const user of page) {
        if (!user.hasEmail || !user.email) result.skipped['no-verified-email']++;
        else if (user.optedOut) result.skipped['opted-out']++;
        else if (!(await inRollout(user.id))) result.skipped['not-in-rollout']++;
        else reachable.push(user);
      }
      const silenced = await silencedUsersAmong(
        read,
        reachable.map((u) => u.id),
        silenceTypes
      );
      const runAt = now();
      const eligible: Candidate[] = [];
      for (const user of reachable) {
        if (silenced.has(user.id)) result.skipped['all-notifications-off']++;
        else if (user.lastSentAt && runAt.getTime() - user.lastSentAt.getTime() < DIGEST_MIN_GAP_MS)
          result.skipped['recently-sent']++;
        else eligible.push(user);
      }

      const windowStart = runAt.getTime() - DIGEST_WINDOW_MS;
      const unseen = eligible.length
        ? await notifications.queryUnseenNotifications({
            users: eligible.map((user) => ({
              userId: user.id,
              since: new Date(Math.max(windowStart, user.lastSentAt?.getTime() ?? 0)),
            })),
            excludeTypes: emailNotificationTypeList,
            limit: DIGEST_ITEM_LIMIT,
          })
        : [];
      const unseenByUser = new Map(unseen.map((u) => [u.userId, u]));

      for (const user of eligible) {
        checkIfCanceled();
        const stop = outOfBudget() ?? ((await emailEnabled()) ? null : ('email-disabled' as const));
        if (stop) {
          result.stopped = stop;
          break pages;
        }
        cursor.lastUserId = user.id;
        const missed = unseenByUser.get(user.id);
        if (!missed) {
          result.skipped['none-unseen']++;
          continue;
        }
        const items = await renderItems(missed);
        if (items.length === 0) {
          result.skipped['unrenderable']++;
          continue;
        }

        if (await optedOutOnPrimary(write, user.id)) {
          result.skipped['opted-out']++;
          continue;
        }

        await pace();
        const sentAt = now();
        await recordSent(write, user.id, sentAt);
        try {
          await withThrottleRetry(() =>
            missedNotificationsDigestEmail.send({
              to: user.email as string,
              items,
              total: Math.max(missed.total, items.length),
              totalIsFloor: missed.floor,
              unsubscribeUrl: getEmailUnsubscribeUrl(user.id, MISSED_DIGEST_EMAIL_TYPE),
            })
          );
          result.emailed++;
        } catch (e) {
          result.failed++;
          // A transport rejection's message names the recipient's address: log only its class.
          logToAxiom({
            type: 'error',
            name: 'notification-digest',
            message: 'digest email could not be sent',
            payload: { userId: user.id, error: (e as Error)?.name },
          });
          await unrecordSent(write, user.id, user.lastSentAt);
        }
      }

      // Every user on the page is now handled, including the ones skipped before the loop.
      if (page.length) cursor.lastUserId = page[page.length - 1]!.id;
      if (page.length < batchSize) {
        cursor.done = true;
        result.cycleDone = true;
        break;
      }
      await dbKV.set(DIGEST_CURSOR_KEY, cursor);
    }
  } finally {
    await dbKV.set(DIGEST_CURSOR_KEY, cursor);
    logToAxiom({
      type: 'info',
      name: 'notification-digest',
      message: 'digest run finished',
      payload: {
        considered: result.considered,
        emailed: result.emailed,
        failed: result.failed,
        skipped: result.skipped,
        stopped: result.stopped,
        cycleDone: result.cycleDone,
        cycleStartedAt: cursor.cycleStartedAt,
        lastUserId: cursor.lastUserId,
      },
    });
  }
  return result;
}
