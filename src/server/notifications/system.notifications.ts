import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

/** What a `tos-violation` notice says was removed. A song and its cover are removed apart, so each
 *  names itself; `modelName` is then the song's title, empty when it has none. */
function tosViolationSubject(details: { entity?: string; modelName?: string }) {
  const title = details.modelName ? ` "${details.modelName}"` : '';
  if (details.entity === 'song') return `Your song${title}`;
  if (details.entity === 'song cover') return `The cover of your song${title}`;
  return `Your ${details.entity} on "${details.modelName}"`;
}

export const systemNotifications = createNotificationProcessor({
  'civitai-features': {
    displayName: 'New Civitai features',
    category: NotificationCategory.System,
    prepareMessage: ({ details }) => ({
      message: `New Features! ${details.featureBlurb}, check it out!`,
      url: `/content/release/${details.releaseSlug}`,
    }),
  },
  'tos-violation': {
    displayName: 'Terms of Service Violation',
    category: NotificationCategory.System,
    toggleable: false,
    // `details.reason` is absent on every notification written before it existed, and on the paths
    // that still do not classify a removal — so the unreasoned wording stays, rather than rendering
    // "violation: undefined" over the whole backlog.
    prepareMessage: ({ details }) => ({
      message: `${tosViolationSubject(details)} has been removed ${
        details.reason
          ? `for a Terms of Service violation: ${details.reason}.`
          : 'due to a Terms of Service violation.'
      }`,
      url: details.url,
    }),
  },
  'system-announcement': {
    displayName: 'System Announcement',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: details.message,
      url: details.url,
    }),
  },
  // Must stay toggleable: push needs a type the user can turn off.
  'event-reminder': {
    displayName: 'Event reminders',
    category: NotificationCategory.System,
    defaultPush: true,
    prepareMessage: ({ details }) => ({
      message: details.message,
      url: details.url,
    }),
  },
  'system-message': {
    displayName: 'Heads Up!',
    category: NotificationCategory.Other,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: details.message,
      url: details.url,
    }),
  },
});
