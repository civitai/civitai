import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';

export const imageNotifications = createNotificationProcessor({
  'image-prompt-rating-raised': {
    displayName: 'Image rating raised by its prompt',
    category: NotificationCategory.Moderation,
    prepareMessage: ({ details }) => {
      if (!details) return undefined;
      const { imageId, level, tag } = details as { imageId: number; level: number; tag: string };
      const label = browsingLevelLabels[level as keyof typeof browsingLevelLabels] ?? '?';
      return {
        message: `Your image is now rated ${label} because its prompt added the "${tag}" tag. Editing the prompt re-checks the tags it added.`,
        url: `/images/${imageId}`,
      };
    },
  },
  'profile-picture-blocked': {
    displayName: 'Avatar blocked',
    category: NotificationCategory.Moderation,
    prepareMessage: () => ({
      message: 'Your avatar has been blocked.',
      url: '/user/account',
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT
          i.id "imageId",
          u.id as "userId"
        FROM "Image" i
        JOIN "User" u ON i.id = u."profilePictureId"
        WHERE i."updatedAt" > '${lastSent}' AND i.ingestion = 'Blocked'::"ImageIngestionStatus"
      )
        SELECT
          CONCAT('profile-picture-blocked:',"imageId") "key",
          "userId",
          'profile-picture-blocked' "type",
          '{}'::jsonb "details"
        FROM data
        WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" uns WHERE uns."userId" = data."userId" AND uns.type = 'profile-picture-blocked')
    `,
  },
});
