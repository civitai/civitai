import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const userJourneyNotifications = createNotificationProcessor({
  'join-community': {
    displayName: 'Welcome to Civitai',
    toggleable: false,
    prepareMessage: () => ({
      message: `Happy to have you here! Come join our Discord server to stay up to date with the community and updates to the platform.`,
      url: `/discord`,
      target: '_blank',
    }),
    prepareQuery: ({ lastSent }) => `
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        id "userId",
        'join-community' "type",
        jsonb_build_object(),
        'System'::"NotificationCategory" "category"
      FROM "User"
      WHERE "createdAt" > '${lastSent}';`,
  },
});
