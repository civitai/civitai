import { getListingDetailHref } from '~/components/Apps/appListingCardView';
import { listingEditHref } from '~/components/Apps/appListingEditorTabs';
import { NotificationCategory } from '~/server/common/enums';
import {
  createNotificationProcessor,
  notBlockedBetween,
} from '~/server/notifications/base.notifications';
import { OWNER_SUBMISSIONS_URL } from '~/server/notifications/app-listing.notifications';
import { APP_LISTING_OWNER_SQL } from '~/server/notifications/comment.notifications';
import type { FeedbackOwnerStatus } from '~/shared/constants/feedback.constants';
import { APP_BLOCK_FEEDBACK_AREA } from '~/shared/constants/feedback.constants';

/**
 * Private per-app feedback (`Feedback.area = 'app-block'`) — the two notifications it sends.
 *
 * 1. `app-feedback-new` — a DAILY DIGEST to the listing OWNER: "3 new feedback messages on
 *    "Pixel Forge"". One per listing per UTC day. Owner only: accepted editors read the inbox but
 *    get no digest.
 * 2. `app-feedback-status` — to the REPORTER, when the developer marks their feedback `resolved`
 *    or `wont_fix`. Never for `acknowledged`.
 *
 * Both default ON and are opt-out. The bulk `prepareQuery` path does not filter
 * `UserNotificationSettings`, so the digest SQL must; the single-row create the status
 * notification goes through does. Moving that one to a bulk create would silently drop its opt-out.
 *
 * 🔴 NEITHER CARRIES ANY FEEDBACK TEXT, and that is a privacy decision, not an omission. A
 * notification is a copy: it is stored by the notifications service and may be pushed to a
 * device, and nothing retracts it. A moderator's "Hide from developer" and a reporter's ban both
 * work by filtering the owner's reads; an excerpt already delivered in a notification would
 * survive both. So the digest says how many and for which app, and the owner reads the text in
 * the inbox, where those filters apply. For the same reason it names no reporter. The reporter's
 * notification names the app and the new status, never the developer.
 */

export const APP_FEEDBACK_DIGEST_TYPE = 'app-feedback-new';
export const APP_FEEDBACK_STATUS_TYPE = 'app-feedback-status';

export const APP_FEEDBACK_EDITOR_TAB = 'feedback';

/**
 * The owner inbox for a listing.
 *
 * @ai: switch to `listingEditHref(appListingId, 'feedback')` and drop APP_FEEDBACK_EDITOR_TAB once
 * the owner inbox change adds `feedback` to `EditorTab`. Until then `resolveEditorTab` sends the
 * unknown tab to the default one, so the link opens the listing's editor. The test pins the URL.
 */
export function appFeedbackInboxHref(appListingId: string): string {
  return `${listingEditHref(appListingId)}?tab=${APP_FEEDBACK_EDITOR_TAB}`;
}

// ---------------------------------------------------------------------------------------------
// Owner digest
// ---------------------------------------------------------------------------------------------

/**
 * The digest's bucket: a Postgres `date_trunc` unit, also used as the bucket length. Changing it
 * also means changing the "(daily)" in the type's `displayName`, and it must stay under the
 * query's 7-day floor.
 */
export const APP_FEEDBACK_DIGEST_BUCKET = 'day';

/**
 * How long after a bucket closes before it is sent. The query reads a replica, and a row's
 * `createdAt` is stamped before its transaction commits, so a report written in the last moments
 * of a bucket can become visible a little after the bucket closes. Waiting this long means such a
 * row is counted in its own bucket instead of being skipped by every run.
 */
export const APP_FEEDBACK_DIGEST_GRACE = '5 minutes';

/** The SQL expression for the moment a row's bucket is sent, as a UTC `timestamp`. */
/**
 * How far each run's window reaches back before its cursor. The cursor is stamped with the APP
 * server's clock while `NOW()` is the DATABASE's, so if the database runs behind, consecutive
 * windows `(lastSent, now]` would leave a gap, and a bucket falling due inside it would never be
 * sent. Overlapping by this much absorbs that skew; a bucket re-emitted in the overlap carries the
 * same `key`, so it is not delivered twice.
 */
export const APP_FEEDBACK_DIGEST_CLOCK_SLACK = '5 minutes';

const digestDueAt = `date_trunc('${APP_FEEDBACK_DIGEST_BUCKET}', f."createdAt") + INTERVAL '1 ${APP_FEEDBACK_DIGEST_BUCKET}' + INTERVAL '${APP_FEEDBACK_DIGEST_GRACE}'`;

/**
 * `NOW()` as a UTC `timestamp`. `createdAt` is a `timestamp WITHOUT time zone` holding UTC, and
 * comparing one against a bare `NOW()` converts it through the SESSION time zone — so on a
 * non-UTC session every bucket's due time would shift by the offset, out of the window the cursor
 * reads. Pinned by the PGlite test running the query under a non-UTC session.
 */
const NOW_UTC = `(NOW() AT TIME ZONE 'UTC')`;

export type AppFeedbackDigestDetails = {
  appListingId: string;
  appName: string | null;
  count: number;
};

export function appFeedbackDigestMessage(details: Partial<AppFeedbackDigestDetails>): string {
  const app = details.appName ? `"${details.appName}"` : 'your app';
  const count = details.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1)
    return `New feedback on ${app}`;
  return `${count} new feedback ${count === 1 ? 'message' : 'messages'} on ${app}`;
}

/**
 * The digest query. One row per (listing, bucket) that CLOSED in this run's window.
 *
 * 🔴 THE CURSOR IS COMPARED TO THE BUCKET'S DUE TIME, NOT TO `createdAt`. That is what makes this
 * a digest while the runner fires every minute: a report is sent exactly once, in the run whose
 * window (widened by APP_FEEDBACK_DIGEST_CLOCK_SLACK) contains its bucket's due time, and the
 * per-type cursor still advances every minute. Do not gate the processor to run once a day
 * instead: its cursor would go stale and trip `notification-cursor-monitor`.
 *
 * What a row must be to count, judged when the digest is sent. The first three are the owner
 * inbox's own rules (`ownerVisibleWhere` and its `new` filter in `app-feedback.service.ts`),
 * restated as SQL text because the runner takes a raw string; the "agrees with the owner inbox"
 * test fails if the inbox's rule set changes without this one:
 *   - still NEW to the developer (`ownerStatus` NULL), as the inbox's New filter counts it;
 *   - not hidden from the developer by a moderator;
 *   - not from a reporter who is now banned;
 *   - not from someone the owner blocked, or who blocked the owner;
 *   - not the owner's own (submission already refuses that; ownership can change afterwards).
 *
 * Recipient: the canonical, kind-aware owner via `APP_LISTING_OWNER_SQL`, never
 * `app_listings.user_id` alone, and never a shadow revision's frozen copy. Editors are not
 * recipients. `key` is per listing per bucket; there is no `dedupeKey`, because that mechanism
 * makes one source event produce one notification ACROSS types, and nothing else is ever sent for
 * a digest bucket.
 */
export function appFeedbackDigestQuery({ lastSent }: { lastSent: string }): string {
  return `
      WITH app_feedback_digest AS (
        SELECT
          ${APP_LISTING_OWNER_SQL} "ownerId",
          al.id "appListingId",
          al.name "appName",
          date_trunc('${APP_FEEDBACK_DIGEST_BUCKET}', f."createdAt") "bucket",
          COUNT(*)::int "count"
        FROM "Feedback" f
        JOIN "User" u ON u.id = f."userId"
        -- INNER: a report whose listing was deleted (appListingId SET NULL) has no owner to tell.
        JOIN "app_listings" al ON al.id = f."appListingId"
        LEFT JOIN "app_blocks" ab ON ab.id = al."app_block_id"
        LEFT JOIN "OauthClient" oc ON oc.id = ab."app_id"
        WHERE f.area = '${APP_BLOCK_FEEDBACK_AREA}'
          AND f."hiddenFromOwnerAt" IS NULL
          AND u."bannedAt" IS NULL
          AND f."ownerStatus" IS NULL
          AND al."revision_of_id" IS NULL
          AND ${APP_LISTING_OWNER_SQL} > 0
          AND f."userId" != ${APP_LISTING_OWNER_SQL}
          -- (recipient, actor): swapped, the owner's Hide of a reporter stops suppressing.
          AND ${notBlockedBetween(APP_LISTING_OWNER_SQL, 'f."userId"')}
          -- The bucket became due inside this run's window.
          AND ${digestDueAt} > '${lastSent}'::timestamp - INTERVAL '${APP_FEEDBACK_DIGEST_CLOCK_SLACK}'
          AND ${digestDueAt} <= ${NOW_UTC}
          -- A floor against cursor drift: a new type's cursor starts at the job's global last run,
          -- which is the epoch on a fresh database and stale by the length of any outage.
          AND f."createdAt" > ${NOW_UTC} - INTERVAL '7 days'
        GROUP BY 1, 2, 3, 4
      )
      SELECT
        concat('${APP_FEEDBACK_DIGEST_TYPE}:', "appListingId", ':', to_char("bucket", 'YYYY-MM-DD"T"HH24')) "key",
        "ownerId" "userId",
        '${APP_FEEDBACK_DIGEST_TYPE}' "type",
        JSONB_BUILD_OBJECT(
          'appListingId', "appListingId",
          'appName', "appName",
          'count', "count"
        ) "details"
      FROM app_feedback_digest
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = '${APP_FEEDBACK_DIGEST_TYPE}');
    `;
}

// ---------------------------------------------------------------------------------------------
// Reporter status change
// ---------------------------------------------------------------------------------------------

/**
 * The owner statuses a reporter hears about, and how each reads. `acknowledged` is deliberately
 * absent: it means "seen", and telling the reporter that invites a reply channel this feature does
 * not have. A Map, not an object: `details` is untrusted JSON, and an object literal would answer
 * for inherited keys.
 */
const NOTIFIED_STATUS_LABELS = new Map<FeedbackOwnerStatus, string>([
  ['resolved', 'resolved'],
  ['wont_fix', "won't fix"],
]);

export function isReporterNotifiedOwnerStatus(status: FeedbackOwnerStatus): boolean {
  return NOTIFIED_STATUS_LABELS.has(status);
}

/**
 * One notification per (feedback, status). Setting the same status again — directly, or after
 * flapping through another — reuses the key, so it is not re-delivered while the earlier
 * notification is still retained by the notifications service.
 */
export function appFeedbackStatusKey(feedbackId: number, ownerStatus: FeedbackOwnerStatus): string {
  return `${APP_FEEDBACK_STATUS_TYPE}:${feedbackId}:${ownerStatus}`;
}

export type AppFeedbackStatusDetails = {
  feedbackId: number;
  ownerStatus: FeedbackOwnerStatus;
  appName: string | null;
  appSlug: string | null;
};

export function appFeedbackStatusMessage(details: Partial<AppFeedbackStatusDetails>) {
  const label = details.ownerStatus ? NOTIFIED_STATUS_LABELS.get(details.ownerStatus) : undefined;
  if (!label) return undefined;
  const app = details.appName ? `"${details.appName}"` : 'an app';
  return {
    message: `The developer of ${app} marked your feedback as ${label}.`,
    url: details.appSlug ? getListingDetailHref(details.appSlug) : undefined,
  };
}

export const appFeedbackNotifications = createNotificationProcessor({
  [APP_FEEDBACK_DIGEST_TYPE]: {
    displayName: 'New private feedback on your apps (daily)',
    category: NotificationCategory.Comment,
    prepareMessage: ({ details }) => {
      const d = details as Partial<AppFeedbackDigestDetails>;
      return {
        message: appFeedbackDigestMessage(d),
        // The query always sets `appListingId`; the fallback only covers a malformed row, and sends
        // the owner to their apps rather than to `/apps/listing/undefined/edit`.
        url: d.appListingId ? appFeedbackInboxHref(d.appListingId) : OWNER_SUBMISSIONS_URL,
      };
    },
    prepareQuery: appFeedbackDigestQuery,
  },
  [APP_FEEDBACK_STATUS_TYPE]: {
    displayName: 'A developer resolved or closed your app feedback',
    category: NotificationCategory.Update,
    prepareMessage: ({ details }) =>
      appFeedbackStatusMessage(details as Partial<AppFeedbackStatusDetails>),
  },
});
