import { randomUUID } from 'node:crypto';
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
import {
  DIGEST_ALL_POSITION,
  DIGEST_FALLBACK_PATH,
  digestTargetPath,
  getDigestClickUrl,
  recordDigestEvents,
  type DigestEvent,
} from '~/server/notifications/digest-tracking';
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
  // First time the user is eligible: their start floor is recorded and nothing is sent.
  'first-pass',
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
  isModerator: boolean;
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
  inRollout?: (userId: number, isModerator: boolean) => Promise<boolean>;
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
      coalesce(u."isModerator", false) AS "isModerator",
      d."lastSentAt"
    FROM "User" u
    LEFT JOIN "UserNotificationDigest" d ON d."userId" = u.id
    WHERE u.id > ${afterId} AND u."deletedAt" IS NULL AND u."bannedAt" IS NULL
    ORDER BY u.id
    LIMIT ${limit}`.execute(db);
  return rows;
}

/**
 * The user re-read on the primary just before the send: the page was read from the replica up to
 * minutes earlier, and an address change, a ban, a deletion or an opt-out since then must hold.
 * The send goes to the address read here, never the page's copy.
 */
async function recipientOnPrimary(db: Kysely<DB>, userId: number) {
  const { rows } = await sql<{ email: string | null; reachable: boolean; optedOut: boolean }>`
    SELECT u.email,
      (u.email IS NOT NULL AND u."emailVerified" IS NOT NULL
        AND u."deletedAt" IS NULL AND u."bannedAt" IS NULL) AS "reachable",
      EXISTS (
        SELECT 1 FROM "UserEmailNotificationOptOut" o
        WHERE o."userId" = u.id AND o."type" = ${MISSED_DIGEST_EMAIL_TYPE}
      ) AS "optedOut"
    FROM "User" u
    WHERE u.id = ${userId}`.execute(db);
  return rows[0] ?? null;
}

/**
 * Claims this week's send for the user. The claim only lands when no digest was recorded within
 * the minimum gap, so two overlapping runs (a lock that failed open, a retry after a crash) cannot
 * both send: the second finds the first's row and gets nothing back.
 */
async function claimSend(db: Kysely<DB>, userId: number, at: Date) {
  const cutoff = new Date(at.getTime() - DIGEST_MIN_GAP_MS);
  const { rows } = await sql<{ userId: number }>`
    INSERT INTO "UserNotificationDigest" ("userId", "lastSentAt") VALUES (${userId}, ${utc(at)})
    ON CONFLICT ("userId") DO UPDATE SET "lastSentAt" = excluded."lastSentAt"
      WHERE "UserNotificationDigest"."lastSentAt" < ${utc(cutoff)}
    RETURNING "userId"`.execute(db);
  return rows.length > 0;
}

/**
 * The start floor. A user eligible for the first time (no `UserNotificationDigest` row) is sent
 * nothing: a row is written with `lastSentAt` = this page's read time, as if a digest had gone out
 * then. Their first real digest comes a pass later and its window starts at that row, so it lists
 * only notifications created after the user entered the rollout, never the backlog from before.
 * Per user, so a user added to the rollout later gets their own later floor. Only users still in
 * `User` get a row (a hard delete since the page read would fail the foreign key); a row another
 * run wrote first is kept. Returns the users this call started.
 */
async function recordStartFloor(db: Kysely<DB>, userIds: number[], at: Date) {
  if (userIds.length === 0) return new Set<number>();
  const { rows } = await sql<{ userId: number }>`
    INSERT INTO "UserNotificationDigest" ("userId", "lastSentAt")
    SELECT u.id, ${utc(at)} FROM "User" u WHERE u.id = any(${userIds}::int[])
    ON CONFLICT ("userId") DO NOTHING
    RETURNING "userId"`.execute(db);
  return new Set(rows.map((r) => r.userId));
}

/**
 * The Flipt evaluation for one user. Segment constraints read the context, not the entity id, so
 * the context carries what a segment for this flag can match on: `userId` and `isModerator`. Tier
 * and membership are not read here, so a tier segment would match nobody.
 */
function digestFliptEvaluation(userId: number, isModerator: boolean) {
  return {
    flag: FLIPT_FEATURE_FLAGS.MISSED_NOTIFICATION_DIGEST,
    entityId: String(userId),
    context: { userId: String(userId), isModerator: String(isModerator) },
  };
}

/**
 * Puts back what the row held before a send that failed, so the next pass tries the user again.
 * Only this run's own claim is undone: a row another run has written since is left alone.
 */
async function unclaimSend(db: Kysely<DB>, userId: number, at: Date, previous: Date | null) {
  if (previous)
    await sql`UPDATE "UserNotificationDigest" SET "lastSentAt" = ${utc(previous)}
      WHERE "userId" = ${userId} AND "lastSentAt" = ${utc(at)}`.execute(db);
  else
    await sql`DELETE FROM "UserNotificationDigest"
      WHERE "userId" = ${userId} AND "lastSentAt" = ${utc(at)}`.execute(db);
}

type RenderedItem = MissedNotificationsDigestItem & { type: string };

/** The listed lines, rendered the way the bell renders them; a type with no message is left out. */
async function renderItems(user: UnseenNotifications): Promise<RenderedItem[]> {
  const bare: BareNotification[] = user.items.map((item) => ({
    id: item.id,
    type: item.type,
    details: { ...item.details },
  }));
  await populateNotificationDetails(bare, { showSfwFace: true });
  const items: RenderedItem[] = [];
  for (const notification of bare) {
    const prepared = getNotificationMessage(notification);
    if (prepared?.message)
      items.push({ message: prepared.message, url: prepared.url, type: notification.type });
  }
  return items;
}

/**
 * The email's links, each routed through the click endpoint with the user, the pass, the email's
 * send id and the item's position and type signed into it. A link off the site is left as it is,
 * untracked.
 */
function trackedLinks(userId: number, cycleStartedAt: Date, items: RenderedItem[], sendId: string) {
  const linked: MissedNotificationsDigestItem[] = items.map(({ message, url, type }, i) => {
    const to = digestTargetPath(url);
    return {
      message,
      url: to
        ? getDigestClickUrl({
            userId,
            cycleStartedAt,
            position: i + 1,
            notificationType: type,
            to,
            sendId,
          })
        : url,
    };
  });
  const allUrl = getDigestClickUrl({
    userId,
    cycleStartedAt,
    position: DIGEST_ALL_POSITION,
    notificationType: '',
    to: DIGEST_FALLBACK_PATH,
    sendId,
  });
  return { items: linked, allUrl };
}

/**
 * One run of the weekly missed-notification digest, resuming where the last run stopped.
 *
 * A user's first eligible pass sends nothing and records their start floor (`recordStartFloor`),
 * so no digest lists a notification from before the user entered the rollout.
 * Types that send their own email (`defaultEmail`) are left out, so the digest never repeats one.
 * Eligibility is re-read on the primary just before each send, and the send goes to the address
 * read there. Each send is claimed in `UserNotificationDigest` BEFORE the email goes out, and the
 * claim fails if a digest was recorded in the last six days, so overlapping runs cannot both send.
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
    inRollout = (userId: number, isModerator: boolean) => {
      const { flag, entityId, context } = digestFliptEvaluation(userId, isModerator);
      return isFlipt(flag, entityId, context);
    },
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

  const cycleStartedAt = new Date(cursor.cycleStartedAt);
  // One `notificationDigestEvents` row per real send (never a start floor, a skip or a failed
  // send), written per page.
  let sends: DigestEvent[] = [];
  const flushSends = async () => {
    const batch = sends;
    sends = [];
    await recordDigestEvents(batch);
  };

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
        else if (!(await inRollout(user.id, user.isModerator))) result.skipped['not-in-rollout']++;
        else reachable.push(user);
      }
      const silenced = await silencedUsersAmong(
        read,
        reachable.map((u) => u.id),
        silenceTypes
      );
      const runAt = now();
      const eligible: Candidate[] = [];
      const starting: number[] = [];
      for (const user of reachable) {
        if (silenced.has(user.id)) result.skipped['all-notifications-off']++;
        else if (!user.lastSentAt) starting.push(user.id);
        else if (runAt.getTime() - user.lastSentAt.getTime() < DIGEST_MIN_GAP_MS)
          result.skipped['recently-sent']++;
        else eligible.push(user);
      }
      // Started users are never asked about or sent to this pass, whether or not this call wrote
      // their row: a row it did not write was written by another run since the page was read
      // (or, rarely, the user was hard-deleted).
      if (starting.length) {
        const started = await recordStartFloor(write, starting, runAt);
        result.skipped['first-pass'] += started.size;
        result.skipped['recently-sent'] += starting.length - started.size;
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

        const recipient = await recipientOnPrimary(write, user.id);
        if (!recipient?.reachable || !recipient.email) {
          result.skipped['no-verified-email']++;
          continue;
        }
        if (recipient.optedOut) {
          result.skipped['opted-out']++;
          continue;
        }
        const to = recipient.email;

        await pace();
        // Recorded as the moment the unseen list was read, not the moment of the send: the next
        // digest starts its window here, so a notification created while this page was being
        // sent is listed next time rather than in neither.
        const sentAt = runAt;
        if (!(await claimSend(write, user.id, sentAt))) {
          result.skipped['recently-sent']++;
          continue;
        }
        try {
          // Ours, not the transport's, so the digest's own click links can carry it.
          const sendId = randomUUID();
          const links = trackedLinks(user.id, cycleStartedAt, items, sendId);
          // `c` names the pass, so an unsubscribe from this email counts against it.
          const unsubscribeUrl = `${getEmailUnsubscribeUrl(
            user.id,
            MISSED_DIGEST_EMAIL_TYPE
          )}&c=${cycleStartedAt.getTime()}`;
          await withThrottleRetry(() =>
            missedNotificationsDigestEmail.send(
              {
                to,
                items: links.items,
                allUrl: links.allUrl,
                total: Math.max(missed.total, items.length),
                totalIsFloor: missed.floor,
                unsubscribeUrl,
              },
              { userId: user.id, campaign: cycleStartedAt.toISOString() },
              { sendId }
            )
          );
          result.emailed++;
          sends.push({
            event: 'send',
            userId: user.id,
            cycleStartedAt,
            sentAt,
            itemCount: items.length,
          });
        } catch (e) {
          result.failed++;
          // A transport rejection's message names the recipient's address: log only its class.
          logToAxiom({
            type: 'error',
            name: 'notification-digest',
            message: 'digest email could not be sent',
            payload: { userId: user.id, error: (e as Error)?.name },
          });
          await unclaimSend(write, user.id, sentAt, user.lastSentAt);
        }
      }

      await flushSends();
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
    await flushSends();
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
