import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { OWNER_SUBMISSIONS_URL } from '~/server/notifications/app-listing.notifications';
import { APP_PLATFORM_UPDATE_SENDER } from '~/shared/constants/app-assistant.constants';

/**
 * App Blocks — Civitai staff pushed a PLATFORM UPDATE to the recipient's app
 * (`app-platform-update.service.ts`): a commit on its own branch of the app's source repo, which the
 * owner's next `civitai app pull` or App Assistant session merges when it applies cleanly.
 *
 * The owner reads it as from {@link APP_PLATFORM_UPDATE_SENDER}, never the staff member's own
 * username (operator decision). `byUsername` is still stored in the details for the record, but
 * the message never renders it, so rows written before that decision read the same way.
 */

export type AppPlatformUpdateNotificationDetails = {
  /** The app's slug, its identity in the message. */
  slug: string;
  /** `apu_<ULID>`. */
  updateId: string;
  /** The staff member's username at push time. Kept for the record; never rendered. */
  byUsername: string;
  /** The moderator's reason, rendered verbatim. */
  reason: string;
  /**
   * The update changes the app's manifest (scopes, permissions, storage) or a storage hook file.
   * Absent reads as false.
   */
  touchesManifest?: boolean;
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
          `${APP_PLATFORM_UPDATE_SENDER} pushed an update to your app ` +
          `"${details.slug}": ${details.reason} ` +
          (details.touchesManifest
            ? `It changes your app's manifest or a storage hook, which decide what your app is ` +
              `allowed to do. `
            : '') +
          `It is merged into your app the next time you pull it or open it in the App Assistant, ` +
          `if it applies cleanly.`,
        url: OWNER_SUBMISSIONS_URL,
      };
    },
  },
});
