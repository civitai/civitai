import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { OWNER_SUBMISSIONS_URL } from '~/server/notifications/app-listing.notifications';

/**
 * App Blocks — Civitai staff pushed a PLATFORM UPDATE to the recipient's app
 * (`app-platform-update.service.ts`): a commit on its own branch of the app's source repo, which the
 * owner's next `civitai app pull` or App Assistant session merges when it applies cleanly.
 *
 * Unlike the moderation types, this one NAMES the staff member: an update is a change to the
 * owner's code, and the owner is told who made it and why so they can judge it (operator
 * decision). The name and the "verified" claim come from the server record and the account's
 * moderator status at push time, never from the commit.
 *
 * Imperative like its siblings: emitted directly via `createNotification`, so no `prepareQuery`
 * and no notifications-DB migration (`type` is free-form text). Registered in
 * `utils.notifications.ts`. Dark until the `app-blocks-platform-updates` flag is on: the only
 * emitter is the moderator push.
 */

export type AppPlatformUpdateNotificationDetails = {
  /** The app's slug, its identity in the message. */
  slug: string;
  /** `apu_<ULID>`. */
  updateId: string;
  /** The staff member's username at push time. */
  byUsername: string;
  /** The moderator's reason, rendered verbatim. */
  reason: string;
};

export const appPlatformUpdateNotifications = createNotificationProcessor({
  'app-platform-update': {
    displayName: 'Update to your app from Civitai staff',
    category: NotificationCategory.System,
    // A change to the recipient's own code: they must always be told.
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppPlatformUpdateNotificationDetails;
      return {
        message:
          `${details.byUsername} (verified Civitai staff) pushed an update to your app ` +
          `"${details.slug}": ${details.reason} ` +
          `It is merged into your app the next time you pull it or open it in the App Assistant, ` +
          `if it applies cleanly.`,
        url: OWNER_SUBMISSIONS_URL,
      };
    },
  },
});
