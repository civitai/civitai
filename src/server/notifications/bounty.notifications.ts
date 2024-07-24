import { milestoneNotificationFix } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

const reactionMilestones = [5, 10, 20, 50, 100] as const;

export const bountyNotifications = createNotificationProcessor({
  // Moveable
  'benefactor-joined': {
    displayName: 'Supporter joined bounty',
    category: NotificationCategory.Bounty,
    toggleable: false, // Disabling since we've disabled split bounties
    prepareMessage: ({ details }) => ({
      message: `${details.benefactorUsername} added ${details.amount} to your bounty "${details.bountyName}"`,
      url: `/bounties/${details.bountyId}`,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT DISTINCT
          bo."userId" "ownerId",
          jsonb_build_object(
            'bountyId', bb."bountyId",
            'bountyName', b.name,
            'benefactorId', bb."userId",
            'benefactorUsername', u.username,
            'amount', bb."unitAmount"
          ) as "details",
          bb."bountyId",
          bb."userId" "benefactorUserId"
        FROM "BountyBenefactor" bb
        JOIN "User" u ON u.id = bb."userId"
        JOIN "Bounty" b ON b.id = bb."bountyId"
        JOIN "BountyBenefactor" bo ON bo."bountyId" = bb."bountyId" AND bo."createdAt" < bb."createdAt"
        WHERE bb."createdAt" > '${lastSent}'
      )
      SELECT
        CONCAT('benefactor-joined:',"bountyId",':',"benefactorUserId") "key",
        "ownerId" "userId",
        'benefactor-joined' "type",
        details
      FROM data
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'benefactor-joined')
    `,
  },
  // nb: this will only trigger once, not again if entry date is postponed
  'bounty-ending': {
    displayName: 'Bounty you are involved in is ending',
    category: NotificationCategory.Bounty,
    prepareMessage: ({ details }) => ({
      message: `The bounty "${details.bountyName}" is ending in 24 hours`,
      url: `/bounties/${details.bountyId}`,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH affected AS (
        SELECT DISTINCT b.id
        FROM "Bounty" b
        WHERE
          -- Now is in 24 hour expiration window
          now() BETWEEN b."expiresAt" - interval '24 hours' AND b."expiresAt"
          -- And last send was before 24 hour window
          AND '${lastSent}' < b."expiresAt" - interval '24 hours'
      ), target_users AS (
        SELECT DISTINCT id, "userId"
        FROM (
          SELECT
            b.id,
            bb."userId"
          FROM affected a
          JOIN "Bounty" b ON b.id = a.id
          JOIN "BountyBenefactor" bb ON b.id = bb."bountyId"
          WHERE bb."awardedAt" IS NULL
          UNION ALL
          SELECT
            b.id,
            be."userId"
          FROM affected a
          JOIN "Bounty" b ON b.id = a.id
          JOIN "BountyEngagement" be ON b.id = be."bountyId"
          WHERE be.type = 'Track'
        ) b
      ), data AS (
        SELECT DISTINCT
          tu."userId" "ownerId",
          jsonb_build_object(
            'bountyId', b.id,
            'bountyName', b.name,
            'bountyEnd', b."expiresAt"
          ) as "details",
          b.id "bountyId"
        FROM affected a
        JOIN "Bounty" b ON b.id = a.id
        JOIN target_users tu ON tu.id = b.id
      )
      SELECT
        CONCAT('bounty-ending:',"bountyId") "key",
        "ownerId" "userId",
        'bounty-ending' "type",
        details
      FROM data
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'bounty-ending')
    `,
  },
  // Moveable
  'bounty-awarded': {
    displayName: 'Bounty awarded to you',
    category: NotificationCategory.Bounty,
    prepareMessage: ({ details }) => ({
      message: `Congrats! You have been awarded ${details.awardAmount} by ${details.benefactorUsername} for your work on "${details.bountyName}"`,
      url: `/bounties/${details.bountyId}`,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT DISTINCT
          be."userId" "ownerId",
          jsonb_build_object(
            'bountyEntryId', be.id,
            'bountyId', be."bountyId",
            'bountyName', b.name,
            'benefactorUsername', bene.username,
            'benefactorId', bb."userId",
            'awardAmount', bb."unitAmount"
          ) as "details",
          be."bountyId",
          bb."userId" "benefactorUserId"
        FROM "BountyBenefactor" bb
        JOIN "Bounty" b ON b.id = bb."bountyId"
        JOIN "User" bene ON bb."userId" = bene.id
        JOIN "BountyEntry" be ON be.id = bb."awardedToId"
        WHERE bb."awardedAt" > '${lastSent}' AND bb."userId" != be."userId"
      )
      SELECT
        -- TODO maybe remove the userIds here        
        CONCAT('bounty-awarded:', "ownerId",':',"bountyId",':',"benefactorUserId") "key",
        "ownerId" "userId",
        'bounty-awarded' "type",
        details
      FROM data
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'bounty-awarded')
    `,
  },
  'bounty-reaction-milestone': {
    displayName: 'Bounty entry reaction milestones',
    category: NotificationCategory.Bounty,
    prepareMessage: ({ details }) => ({
      message: `Your bounty entry on "${
        details.bountyName
      }" has reached ${details.reactionCount.toLocaleString()} reactions`,
      url: `/bounties/${details.bountyId}/entries/${details.bountyEntryId}`,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH milestones AS (
        SELECT * FROM (VALUES ${reactionMilestones.map((x) => `(${x})`).join(', ')}) m(value)
      ), affected AS (
        SELECT DISTINCT
          "bountyEntryId"
        FROM "BountyEntryReaction"
        WHERE "createdAt" > '${lastSent}'
      ), affected_value AS (
        SELECT
          br."bountyEntryId",
          COUNT(*) "reaction_count"
        FROM affected a
        JOIN "BountyEntryReaction" br ON br."bountyEntryId" = a."bountyEntryId"
        GROUP BY br."bountyEntryId"
      ), data AS (
        SELECT DISTINCT
          be."userId" "ownerId",
          jsonb_build_object(
            'bountyId', be."bountyId",
            'bountyName', b.name,
            'bountyEntryId', be.id,
            'reactionCount', ms.value
          ) as "details",
          a."bountyEntryId",
          ms.value "milestone"
        FROM affected_value a
        JOIN "BountyEntry" be ON be.id = a."bountyEntryId"
        JOIN "Bounty" b ON b.id = be."bountyId"
        JOIN milestones ms ON ms.value <= a.reaction_count
        WHERE b."createdAt" > '${milestoneNotificationFix}'
      )
      SELECT
        CONCAT('bounty-reaction-milestone:',"bountyEntryId",':',milestone) "key",
        "ownerId" "userId",
        'bounty-reaction-milestone' "type",
        details
      FROM data
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'bounty-reaction-milestone')
    `,
  },
  // Moveable
  'bounty-entry': {
    displayName: 'New entry on bounty you are involved in',
    category: NotificationCategory.Bounty,
    prepareMessage: ({ details }) => ({
      message: `${details.hunterUsername} has submitted an entry to the bounty "${details.bountyName}"`,
      url: `/bounties/${details.bountyId}/entries/${details.bountyEntryId}`,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH affected AS (
        SELECT DISTINCT
          "bountyId"
        FROM "BountyEntry" be
        WHERE "createdAt" > '${lastSent}'
      ), target_users AS (
        SELECT DISTINCT id, "userId"
        FROM (
          SELECT
            b.id,
            bb."userId"
          FROM affected a
          JOIN "Bounty" b ON b.id = a."bountyId"
          JOIN "BountyBenefactor" bb ON b.id = bb."bountyId"
          UNION ALL
          SELECT
            b.id,
            be."userId"
          FROM affected a
          JOIN "Bounty" b ON b.id = a."bountyId"
          JOIN "BountyEngagement" be ON b.id = be."bountyId"
        ) b
      ), data AS (
        SELECT DISTINCT
          tu."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'bountyName', b.name,
            'bountyId', b.id,
            'hunterUsername', u.username,
            'bountyEntryId', be.id
          ) as details,
          be.id "bountyEntryId"
        FROM target_users tu
        JOIN "Bounty" b ON b.id = tu.id
        JOIN "BountyEntry" be ON be."bountyId" = tu.id AND be."createdAt" > '${lastSent}'
        JOIN "User" u ON u.id = be."userId"
        WHERE be."userId" != tu."userId"
      )
      SELECT
        CONCAT('bounty-entry:',"bountyEntryId") "key",
        "ownerId" "userId",
        'bounty-entry' "type",
        details
      FROM data
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'bounty-entry')
    `,
  },
});
