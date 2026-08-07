import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

/**
 * A pending placement is invisible to the creator until something tells them.
 *
 * Without this the review path is a trap: the placer's Buzz sits in escrow, the
 * owner never learns there is anything to answer, and the only thing that
 * resolves it is the 48-hour expiry — which reads to both sides as the feature
 * being broken rather than as nobody having looked.
 *
 * The link goes to the **image**, not to the queue. Answering means seeing the
 * sticker on the work it was placed on; a list can tell you something is waiting
 * but not whether you want it there.
 */
export const placementNotifications = createNotificationProcessor({
  'sticker-placement-pending': {
    displayName: 'Sticker awaiting your review',
    category: NotificationCategory.Creator,
    prepareMessage: ({ details }) => ({
      message: `${details.placerUsername} wants to place a sticker on your image for ${details.amount} Buzz`,
      url: `/images/${details.imageId}`,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT
          p."ownerId" "userId",
          p.id "placementId",
          jsonb_build_object(
            'placementId', p.id,
            'imageId', p."targetId",
            'placerId', p."placerId",
            'placerUsername', u.username,
            'amount', p.amount
          ) as "details"
        FROM "Placement" p
        JOIN "User" u ON u.id = p."placerId"
        WHERE p.surface = 'sticker'
          AND p."targetType" = 'image'
          -- Only rows that are still waiting. A placement approved, declined or
          -- expired between the last run and this one has already been answered,
          -- and telling someone to review it sends them to a dead link.
          AND p.status = 'pending'
          AND p."createdAt" > '${lastSent}'
      )
      SELECT
        CONCAT('sticker-placement-pending:',"placementId") "key",
        "userId",
        'sticker-placement-pending' "type",
        details
      FROM data
    `,
  },
});
