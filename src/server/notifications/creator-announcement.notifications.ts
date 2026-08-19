import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const creatorAnnouncementNotifications = createNotificationProcessor({
  'creator-announcement': {
    displayName: 'Announcements from creators you follow',
    category: NotificationCategory.Update,
    prepareMessage: ({ details }) => ({
      message: `${details.username} made an announcement: ${details.title}. Check it out.`,
      url: `/user/${details.username}?announcement=${details.announcementId}`,
    }),
    /**
     * Fans out to the author's followers.
     *
     * Audience is resolved here rather than materialised at save time: the allowlist
     * `AnnouncementUser` caps at 50,000 rows and the largest eligible creator already has
     * 53,085 followers, so rows cannot express the audience at all — and a creator who
     * gains followers between writing and going live should reach them too.
     *
     * `profileOnly` rows are excluded: those are the migrated profile banners and anything
     * a creator pins to their own profile. They notify nobody by definition.
     */
    prepareQuery: ({ lastSent }) => `
      WITH live_announcements AS (
        SELECT
          a.id announcement_id,
          a."userId" author_id,
          a.title,
          u.username
        FROM "Announcement" a
        JOIN "User" u ON u.id = a."userId"
        WHERE a."userId" IS NOT NULL
          AND a."profileOnly" = false
          AND a.disabled = false
          AND COALESCE(a."startsAt", a."createdAt") >= '${lastSent}'
          AND COALESCE(a."startsAt", a."createdAt") < now()
          AND (a."endsAt" IS NULL OR a."endsAt" > now())
          -- Wall-clock floor, matching new-model-version: a stale cursor must not turn
          -- this into a scan of every announcement ever written.
          AND COALESCE(a."startsAt", a."createdAt") > now() - INTERVAL '30 minutes'
      ), recipients AS (
        SELECT DISTINCT
          ue."userId" recipient_id,
          jsonb_build_object(
            'announcementId', la.announcement_id,
            'title', la.title,
            'username', la.username,
            'creatorId', la.author_id
          ) details
        FROM live_announcements la
        -- Index-only scan on UserEngagement_type_targetUserId_idx, which exists in prod
        -- but is NOT declared in schema.full.prisma. A database built from the schema
        -- alone seq-scans 11.7M rows here.
        JOIN "UserEngagement" ue
          ON ue."targetUserId" = la.author_id AND ue.type = 'Follow'
        -- The per-creator escape hatch: silences one author without unfollowing them.
        WHERE NOT EXISTS (
          SELECT 1 FROM "UserAnnouncementMute" m
          WHERE m."userId" = ue."userId" AND m."creatorId" = la.author_id
        )
      )
      SELECT
        concat('creator-announcement:', details->>'announcementId') "key",
        recipient_id "userId",
        'creator-announcement' "type",
        details
      FROM recipients r
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" uns
        WHERE uns."userId" = r.recipient_id AND uns.type = 'creator-announcement')
    `,
  },
});
