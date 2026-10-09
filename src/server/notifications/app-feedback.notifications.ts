import { getListingDetailHref } from '~/components/Apps/appListingCardView';
import { listingEditHref } from '~/components/Apps/appListingEditorTabs';
import { NotificationCategory } from '~/server/common/enums';
import {
  createNotificationProcessor,
  notBlockedBetween,
} from '~/server/notifications/base.notifications';
import { OWNER_SUBMISSIONS_URL } from '~/server/notifications/app-listing.notifications';
import { APP_LISTING_OWNER_SQL } from '~/server/notifications/comment.notifications';
import {
  OWNER_NEW_FEEDBACK_SQL,
  OWNER_VISIBLE_FEEDBACK_SQL,
} from '~/server/services/blocks/app-feedback-visibility';
import type { FeedbackOwnerStatus } from '~/shared/constants/feedback.constants';

/**
 * Private per-app feedback (`Feedback.area = 'app-block'`) — the two notifications it sends.
 *
 * 1. `app-feedback-new` — a DIGEST to the listing OWNER: "3 new feedback messages on
 *    "Pixel Forge"". At most one per listing per run of the notifications job, counting what
 *    arrived since the previous run. Owner only: accepted editors read the inbox but get no digest.
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
 * The digest query: one row per listing per job run that saw new feedback on it, modelled on
 * `new-app-listing-comment` — the processor's standard cursor (`createdAt > lastSent`), the same
 * kind-aware owner, the same shadow-revision exclusion and the same block check.
 *
 * Which rows the developer may see, and what "new" is, are NOT written here: they are
 * `OWNER_VISIBLE_FEEDBACK_SQL` and `OWNER_NEW_FEEDBACK_SQL`, the text the owner inbox's list and
 * New counts run, so the digest cannot announce a row the inbox it links to would not show. On top
 * of those, a row must be:
 *   - not from someone the owner blocked or hid, or who blocked the owner;
 *   - not the owner's own (submission already refuses that; ownership can change afterwards).
 *
 * Recipient: the canonical, kind-aware owner via `APP_LISTING_OWNER_SQL`, never
 * `app_listings.user_id` alone, and never a shadow revision's frozen copy. Editors are not
 * recipients.
 *
 * `key` is per listing per batch, the batch named by its highest feedback id. Runs read disjoint
 * rows (each reads `createdAt` past the previous run's cursor), so two runs never produce the same
 * key, while a run repeated before its cursor advanced reproduces its own. There is no `dedupeKey`:
 * that column collapses one source event that several TYPES notify about (a comment that is both
 * a mention and a reply), and nothing else is ever sent about a feedback batch, so it would only
 * repeat `key`. A processor that sets one must also declare a batch `priority`
 * (`comment.dedupe-key.test.ts`).
 */
export function appFeedbackDigestQuery({ lastSent }: { lastSent: string }): string {
  return `
      WITH app_feedback_digest AS (
        SELECT
          ${APP_LISTING_OWNER_SQL} "ownerId",
          al.id "appListingId",
          al.name "appName",
          COUNT(*)::int "count",
          MAX(f.id) "maxFeedbackId"
        FROM "Feedback" f
        JOIN "User" u ON u.id = f."userId"
        -- INNER: a report whose listing was deleted (appListingId SET NULL) has no owner to tell.
        JOIN "app_listings" al ON al.id = f."appListingId"
        LEFT JOIN "app_blocks" ab ON ab.id = al."app_block_id"
        LEFT JOIN "OauthClient" oc ON oc.id = ab."app_id"
        WHERE ${OWNER_VISIBLE_FEEDBACK_SQL}
          AND ${OWNER_NEW_FEEDBACK_SQL}
          AND al."revision_of_id" IS NULL
          AND ${APP_LISTING_OWNER_SQL} > 0
          AND f."userId" != ${APP_LISTING_OWNER_SQL}
          -- (recipient, actor): swapped, the owner's Hide of a reporter stops suppressing.
          AND ${notBlockedBetween(APP_LISTING_OWNER_SQL, 'f."userId"')}
          AND f."createdAt" > '${lastSent}'
          -- The floor against cursor drift: this type's cursor starts at the job's global last run,
          -- the epoch on a fresh database and stale by the length of any outage. It bounds that
          -- first batch's scan, and keeps its count to the last week. There is no hard launch-date
          -- floor (new-app-listing-comment has one, for comments older than it): an app-block row
          -- still "new" is unread by the developer whenever it was written, so announcing it is
          -- never wrong, and the rolling floor already bounds how many.
          AND f."createdAt" > NOW() - INTERVAL '7 days'
        GROUP BY 1, 2, 3
      )
      SELECT
        concat('${APP_FEEDBACK_DIGEST_TYPE}:', "appListingId", ':', "maxFeedbackId") "key",
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
    displayName: 'New private feedback on your apps',
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
