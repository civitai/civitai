import { NotificationCategory } from '~/server/common/enums';
import {
  approvedAppUrl,
  type AppBlockModerationNotificationDetails,
} from '~/server/notifications/app-block.notifications';
import { appReviewByline, withApprovalNote } from '~/server/notifications/app-review-attribution';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { OWNER_SUBMISSIONS_URL } from '~/server/notifications/app-listing.notifications';

/**
 * App Blocks — Civitai staff SUBMITTED a new version of the recipient's app for review on their
 * behalf: the approved version with a staff platform update applied
 * (`app-platform-update-submit.service.ts`). It goes through the normal moderator review.
 *
 * Like `app-platform-update`, it names the staff member (operator decision). Imperative: emitted
 * directly via `createNotification`, so no `prepareQuery` and no notifications-DB migration.
 * Registered in `utils.notifications.ts`. Dark until the `app-blocks-platform-updates` flag is on:
 * the only emitter is the moderator procedure `appPlatformUpdates.submitOnBehalf`.
 */

export type AppPlatformUpdateSubmittedNotificationDetails = {
  slug: string;
  /** `apu_<ULID>`. */
  updateId: string;
  /** `pubreq_<ULID>`: the publish request the staff member filed. */
  publishRequestId: string;
  /** The version the request carries. */
  version: string;
  /** The staff member's username at submit time. */
  byUsername: string;
  /** The update's recorded reason, rendered verbatim. */
  reason: string;
};

/**
 * The REVIEW OUTCOME of a staff on-behalf submit, sent to the app's OWNER (`approveRequest` /
 * `rejectRequest`, beside the submitter's own `app-block-approved` / `app-block-rejected`, which
 * goes to the moderator who filed it). The request names its submitter as the moderator, so
 * without these the owner would never hear what happened to a new version of their own app.
 */
export type AppPlatformUpdateReviewedNotificationDetails = AppBlockModerationNotificationDetails & {
  /** `apu_<ULID>`. */
  updateId: string;
  /** The staff member who submitted it, as recorded at submit time. */
  byUsername: string;
  /**
   * Rejected only: the reject withdrew the platform update (`superseded`), so it is no longer
   * merged into the owner's app. Absent when it could not be withdrawn (already merged).
   */
  updateWithdrawn?: boolean;
};

/** `"Name"` when the manifest had one, else the slug in quotes. */
function quotedApp(details: AppPlatformUpdateReviewedNotificationDetails): string {
  const name = details.name?.trim();
  return `"${name || details.slug}"`;
}

/** The shared head: whose submission this was, and that it is the owner's app. */
function onBehalfHead(details: AppPlatformUpdateReviewedNotificationDetails): string {
  const version = details.version ? `Version ${details.version}` : 'The version';
  return (
    `${version} of your app ${quotedApp(details)}, which ${details.byUsername} ` +
    `(verified Civitai staff) submitted on your behalf as a platform update,`
  );
}

export const appPlatformUpdateSubmitNotifications = createNotificationProcessor({
  'app-platform-update-approved': {
    displayName: 'A staff platform update to your app was approved',
    category: NotificationCategory.System,
    // A new version of the recipient's own app goes live: they must always be told.
    toggleable: false,
    defaultEmail: true,
    prepareMessage: (notification) => {
      const details = notification.details as AppPlatformUpdateReviewedNotificationDetails;
      return {
        message: withApprovalNote(
          `${onBehalfHead(details)} was approved and will be live in a few minutes.`,
          details.approvalNote
        ),
        url: approvedAppUrl(details),
        byline: appReviewByline(details),
      };
    },
  },
  'app-platform-update-rejected': {
    displayName: 'A staff platform update to your app was not approved',
    category: NotificationCategory.System,
    toggleable: false,
    defaultEmail: true,
    prepareMessage: (notification) => {
      const details = notification.details as AppPlatformUpdateReviewedNotificationDetails;
      const reason = details.reason?.trim();
      const head = `${onBehalfHead(details)} was not approved${reason ? `: ${reason}` : '.'}`;
      return {
        message: details.updateWithdrawn
          ? `${head}${/[.!?]$/.test(head) ? '' : '.'} The update was withdrawn and will not be ` +
            `merged into your app.`
          : head,
        url: OWNER_SUBMISSIONS_URL,
        byline: appReviewByline(details),
      };
    },
  },
  'app-platform-update-submitted': {
    displayName: 'Civitai staff submitted an update to your app for review',
    category: NotificationCategory.System,
    // A new version of the recipient's own app is in review: they must always be told.
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppPlatformUpdateSubmittedNotificationDetails;
      return {
        message:
          `${details.byUsername} (verified Civitai staff) submitted version ${details.version} ` +
          `of your app "${details.slug}" for review on your behalf: your approved version with ` +
          `their update (${details.reason}). A moderator reviews it like any other submission. ` +
          `The update also stays on its branch and is merged into your app the next time you ` +
          `pull it or open it in the App Assistant, unless this version is rejected: a ` +
          `rejection withdraws the update.`,
        url: OWNER_SUBMISSIONS_URL,
      };
    },
  },
});
