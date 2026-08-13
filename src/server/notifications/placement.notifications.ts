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
          -- Stamped by holdPlacementEscrow, so its presence means the escrow has
          -- at least been attempted. The row is created before that runs, and a
          -- notification landing in the gap would send someone to review a
          -- placement that is about to be unwound, or one in an auto space that
          -- approves itself seconds later.
          AND p."expiresAt" IS NOT NULL
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

  /**
   * Same trap as the sticker one, with a longer fuse: a gallery submission the
   * owner never sees expires at 48 hours and refunds, so silence costs the
   * submitter two days of held Buzz and tells the owner nothing.
   *
   * Links to the host image rather than to a queue: deciding whether a remix
   * belongs next to your work means seeing your work.
   */
  'remix-gallery-pending': {
    displayName: 'Remix awaiting your review',
    category: NotificationCategory.Creator,
    prepareMessage: ({ details }) => ({
      message: `${details.placerUsername} wants to add a remix to your gallery for ${details.amount} Buzz`,
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
        WHERE p.surface = 'remixGallery'
          AND p."targetType" = 'image'
          AND p.status = 'pending'
          -- Stamped by holdPlacementEscrow. Its absence means the row exists but
          -- the escrow has not been attempted, and a notification landing in that
          -- gap sends someone to review a submission about to be unwound.
          AND p."expiresAt" IS NOT NULL
          AND p."createdAt" > '${lastSent}'
      )
      SELECT
        CONCAT('remix-gallery-pending:',"placementId") "key",
        "userId",
        'remix-gallery-pending' "type",
        details
      FROM data
    `,
  },

  /**
   * The submitter's side of the same decision. They paid and then waited, and
   * without this the only signal that anything happened is their Buzz balance.
   *
   * Approve and decline share one type so the two cannot disagree about what
   * counts as resolved — the message branches on the stored status instead.
   *
   * Deliberately excludes `expired`: nobody decided anything, the refund is
   * full, and telling someone their submission was rejected when the owner
   * simply never looked is both wrong and worse.
   */
  'remix-gallery-resolved': {
    displayName: 'Your remix submission was answered',
    category: NotificationCategory.Creator,
    prepareMessage: ({ details }) => {
      const url = `/images/${details.imageId}`;
      if (details.status === 'approved')
        return { message: `${details.ownerUsername} added your remix to their gallery`, url };
      // Removal is not a decline — it happened after the entry was live, and
      // approval had already paid the owner, so nothing is refunded. Saying
      // "declined" would imply a fee they never paid; promising a refund would
      // be worse.
      if (details.status === 'removed')
        return {
          message: `${details.ownerUsername} removed your remix from their gallery`,
          url,
        };
      return { message: `${details.ownerUsername} declined your remix submission`, url };
    },
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT
          p."placerId" "userId",
          p.id "placementId",
          p.status "status",
          jsonb_build_object(
            'placementId', p.id,
            'imageId', p."targetId",
            'ownerId', p."ownerId",
            'ownerUsername', u.username,
            'status', p.status,
            'removedBy', p."removedBy",
            'amount', p.amount
          ) as "details"
        FROM "Placement" p
        JOIN "User" u ON u.id = p."ownerId"
        WHERE p.surface = 'remixGallery'
          AND p."targetType" = 'image'
          -- Each branch keys off the moment its own actor acted, never off
          -- createdAt: a submission made before the last run and answered after
          -- it would be missed entirely by a createdAt window.
          --
          -- Removal is deliberately a separate branch on takenDownAt, because
          -- taking a live entry down does not touch resolvedAt -- that column
          -- records who approved it, and this path must not destroy the
          -- approval trail.
          AND (
            (
              p.status IN ('approved', 'declined')
              AND p."resolvedAt" IS NOT NULL
              AND p."resolvedAt" > '${lastSent}'
            )
            OR (
              p.status = 'removed'
              AND p."removedBy" = 'owner'
              AND p."takenDownAt" IS NOT NULL
              AND p."takenDownAt" > '${lastSent}'
            )
          )
      )
      SELECT
        -- The status is part of the key because one placement legitimately
        -- produces two of these: approved, then removed later. Keying on the id
        -- alone means the approval burns the key and the removal is deduped
        -- away silently.
        CONCAT('remix-gallery-resolved:',"status",':',"placementId") "key",
        "userId",
        'remix-gallery-resolved' "type",
        details
      FROM data
    `,
  },
});
