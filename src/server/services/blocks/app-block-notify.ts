import type { AppBlockModerationNotificationDetails } from '~/server/notifications/app-block.notifications';
import {
  appReviewAttributionDetails,
  type AppReviewAttribution,
} from '~/server/notifications/app-review-attribution';

/**
 * App Blocks (on-site) — submitter-notification emit helper.
 *
 * A thin, best-effort wrapper `approveRequest` / `rejectRequest` call AFTER their
 * state transition commits, to notify the SUBMITTING developer of the moderator
 * decision. Kept in a DEDICATED module whose only static imports are a TYPE (erased at
 * compile) and the dependency-free `app-review-attribution` leaf, and which DYNAMICALLY
 * imports `createNotification` + `NotificationCategory` inside the async body — so
 * importing this helper adds no meaningful runtime graph to the caller (mirrors the off-site `app-listing-notify` helper and
 * the publish-request service's own dynamic-import discipline for heavy deps). This
 * keeps the service's unit tests from pulling the notifications client; a test that
 * asserts emission mocks THIS module (`~/server/services/blocks/app-block-notify`),
 * and a test that asserts the swallow mocks `~/server/services/notification.service`.
 *
 * `createNotification` is itself best-effort (it swallows client errors + logs), and
 * this is emitted post-commit, so a notification failure never affects the decision.
 * The CALLERS additionally wrap this call in a try/catch — so even a defect that made
 * this helper throw can never fail or roll back a moderator approve/reject.
 */

export type AppBlockSubmitterNotificationType =
  | 'app-block-approved'
  | 'app-block-rejected'
  // The OWNER's copy of a staff on-behalf submit's outcome; same details plus the update and the
  // staff member (`app-platform-update-submit.notifications.ts`).
  | 'app-platform-update-approved'
  | 'app-platform-update-rejected';

/** The approved types: they record whether the recipient can open run pages. */
const APPROVED_TYPES: ReadonlySet<AppBlockSubmitterNotificationType> = new Set([
  'app-block-approved',
  'app-platform-update-approved',
]);

/**
 * An APPROVED notification also records whether the submitter can open run pages
 * (`canOpenRunPage`, read from their feature flags now), so its link never 404s for a submitter
 * outside the run-page rollout. `canOpenRunPages` is the reader; the default asks
 * `canUserOpenAppRunPages`. Any failure reads as `false`.
 */
export async function notifyAppBlockSubmitter(
  opts: {
    type: AppBlockSubmitterNotificationType;
    userId: number;
    /** Idempotency key — dedups repeat emissions of the same event to the same user. */
    key: string;
    details: AppBlockModerationNotificationDetails & {
      updateId?: string;
      byUsername?: string;
      /** `app-platform-update-rejected` only: the update was withdrawn by the reject. */
      updateWithdrawn?: boolean;
    };
    /** Who decided; becomes the notification's "Reviewed by" line. */
    attribution: AppReviewAttribution;
  },
  canOpenRunPages: (userId: number) => Promise<boolean> = async (userId) =>
    (await import('~/server/services/blocks/app-run-page-access')).canUserOpenAppRunPages(userId)
): Promise<void> {
  const [{ createNotification }, { NotificationCategory }] = await Promise.all([
    import('~/server/services/notification.service'),
    import('~/server/common/enums'),
  ]);
  const attributed: AppBlockModerationNotificationDetails = {
    ...opts.details,
    ...appReviewAttributionDetails(opts.attribution),
  };
  const details: AppBlockModerationNotificationDetails = APPROVED_TYPES.has(opts.type)
    ? {
        ...attributed,
        // A failed read must not cost the notification: it then links the submissions view.
        canOpenRunPage: await canOpenRunPages(opts.userId).catch(() => false),
      }
    : attributed;
  await createNotification({
    userId: opts.userId,
    category: NotificationCategory.System,
    type: opts.type,
    key: opts.key,
    details,
  });
}
