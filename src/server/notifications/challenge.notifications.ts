import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { asOrdinal, numberWithCommas } from '~/utils/number-helpers';

export const challengeNotifications = createNotificationProcessor({
  'challenge-winner': {
    displayName: 'Challenge Winner',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      // A user challenge whose pool was never funded pays 0 — don't congratulate them on winning it.
      message: `You placed ${asOrdinal(details.position)} in the "${
        details.challengeName
      }" challenge!${
        details.prize > 0 ? ` You've won ${numberWithCommas(details.prize)} Buzz.` : ''
      }`,
      url: `/challenges/${details.challengeId}`,
    }),
  },
  'challenge-participation': {
    displayName: 'Challenge Participation',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `You've submitted enough entries to earn the participation prize in the "${
        details.challengeName
      }" challenge! You've won ${numberWithCommas(details.prize)} Buzz.`,
      url: `/challenges/${details.challengeId}`,
    }),
  },
  'challenge-rejection': {
    displayName: 'Challenge Rejection',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `${details.count} entries to the "${details.challengeName}" challenge have been declined. Consider making new entries to improve your chances of winning!`,
      url: `/challenges/${details.challengeId}`,
    }),
  },
  'challenge-resource': {
    displayName: `Your resource has been selected for today's challenge`,
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Your resource "${details.resourceName}" has been selected for the "${details.challengeName}" challenge! Check all the details by clicking on this notification.`,
      url: `/challenges/${details.challengeId}`,
    }),
  },
  'challenge-cancelled': {
    displayName: 'Challenge Cancelled',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `The "${
        details.challengeTitle
      }" challenge was cancelled. The prize pool portion of your entry fee (${numberWithCommas(
        details.refundedBuzz
      )} Buzz per entry) has been refunded to your account — the platform fee portion of each entry is not refunded.`,
      url: `/challenges/${details.challengeId}`,
    }),
  },
  'challenge-starting': {
    displayName: 'Challenge you follow is starting',
    category: NotificationCategory.Update,
    toggleable: true,
    prepareMessage: ({ details }) => ({
      message: `The "${details.challengeTitle}" challenge is now live — submit your entries!`,
      url: `/challenges/${details.challengeId}`,
    }),
  },
  'new-challenge-from-following': {
    displayName: 'New challenges from followed users',
    category: NotificationCategory.Update,
    toggleable: true,
    prepareMessage: ({ details }) => ({
      message: `${details.username} posted a new challenge: ${details.challengeTitle}`,
      url: `/challenges/${details.challengeId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_challenge_from_following AS (
        SELECT DISTINCT
          ue."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'challengeId', c.id,
            'challengeTitle', c.title,
            'username', u.username
          ) "details",
          c.id "challengeId"
        FROM "Challenge" c
        JOIN "User" u ON u.id = c."createdById"
        JOIN "UserEngagement" ue
          ON ue."targetUserId" = c."createdById" AND ue.type = 'Follow'
        JOIN "User" ru ON ru.id = ue."userId"
        LEFT JOIN "Image" cover ON cover.id = c."coverImageId"
        WHERE
          c.source = 'User'
          AND c.ingestion = 'Scanned'
          AND c.status IN ('Scheduled', 'Active')
          AND c."visibleAt" >= ue."createdAt"
          -- 59s lookback buffer: the send-notifications cursor can advance past a visibleAt that
          -- lands just before it. Duplicates are safe (ON CONFLICT upsert on key).
          AND c."visibleAt" BETWEEN '${lastSent}'::timestamptz - interval '59 second' AND now()
          -- Wall-clock floor: bounds the Challenge x UserEngagement scan no matter how far behind
          -- the cursor is. Do not replace with an incrementally-advancing row cap.
          AND c."visibleAt" > NOW() - INTERVAL '30 minutes'
          AND (cover."nsfwLevel" & ru."browsingLevel") <> 0
          AND NOT EXISTS (
            SELECT 1 FROM "UserEngagement" blk
            WHERE (
                blk."userId" = ue."userId"
                AND blk."targetUserId" = c."createdById"
                AND blk.type IN ('Block', 'Hide')
              ) OR (
                blk."userId" = c."createdById"
                AND blk."targetUserId" = ue."userId"
                AND blk.type = 'Block'
              )
          )
      )
      SELECT
        CONCAT('new-challenge-from-following:', "challengeId") "key",
        "ownerId" "userId",
        'new-challenge-from-following' "type",
        details
      FROM new_challenge_from_following
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-challenge-from-following')
    `,
  },
  'challenge-ending-soon': {
    displayName: 'Challenge you are tracking is ending',
    category: NotificationCategory.Update,
    toggleable: true,
    prepareMessage: ({ details }) => ({
      message: `The "${details.challengeTitle}" challenge closes in 24 hours — get your entries in.`,
      url: `/challenges/${details.challengeId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH affected AS (
        SELECT c.id, c.title, c."collectionId"
        FROM "Challenge" c
        WHERE
          c.status = 'Active'
          -- Now is inside the 24 hour window...
          AND now() BETWEEN c."endsAt" - interval '24 hours' AND c."endsAt"
          -- ...and the last scan was before it, so this fires once on the crossing.
          AND '${lastSent}'::timestamptz < c."endsAt" - interval '24 hours'
      ), target_users AS (
        SELECT DISTINCT "challengeId", "userId" FROM (
          SELECT a.id "challengeId", ce."userId"
          FROM affected a
          JOIN "ChallengeEngagement" ce ON ce."challengeId" = a.id AND ce.type = 'Notify'
          UNION ALL
          SELECT a.id "challengeId", ci."addedById" "userId"
          FROM affected a
          JOIN "CollectionItem" ci ON ci."collectionId" = a."collectionId"
          WHERE ci."addedById" IS NOT NULL
        ) u
      )
      SELECT
        CONCAT('challenge-ending-soon:', a.id) "key",
        tu."userId" "userId",
        'challenge-ending-soon' "type",
        JSONB_BUILD_OBJECT('challengeId', a.id, 'challengeTitle', a.title) "details"
      FROM affected a
      JOIN target_users tu ON tu."challengeId" = a.id
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = tu."userId" AND type = 'challenge-ending-soon')
    `,
  },
  'challenge-results': {
    displayName: 'Results for a challenge you are tracking',
    category: NotificationCategory.Update,
    toggleable: true,
    prepareMessage: ({ details }) => ({
      message: `Winners have been announced for the "${details.challengeTitle}" challenge.`,
      url: `/challenges/${details.challengeId}`,
    }),
  },
});
