import { NotificationCategory } from '~/server/common/enums';
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

export const appPlatformUpdateSubmitNotifications = createNotificationProcessor({
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
          `pull it or open it in the App Assistant.`,
        url: OWNER_SUBMISSIONS_URL,
      };
    },
  },
});
