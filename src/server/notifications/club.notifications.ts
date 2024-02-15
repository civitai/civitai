import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { getDisplayName } from '../../utils/string-helpers';
import { formatDate } from '../../utils/date-helpers';

export const clubNotifications = createNotificationProcessor({
  'club-new-member-joined': {
    displayName: 'New Member Joined your club!',
    category: 'Update',
    toggleable: false,
    prepareMessage: ({ details }) => {
      return {
        message: `A new user has joined the club ${details.clubName} as a member of the tier ${details.tierName}!`,
        url: `/clubs/manage/${details.clubId}/members`,
      };
    },
    prepareQuery: async ({ lastSent }) => `
       WITH data AS (
        SELECT
          c.id "clubId",
          c.name "clubName",
          ct.name "tierName",
          c."userId"
        FROM "ClubMembership" cm
        JOIN "Club" c ON cm."clubId" = c.id
        JOIN "ClubTier" ct ON cm."clubTierId" = ct.id
        WHERE cm."startedAt" > '${lastSent}'

        UNION

        SELECT
          c.id "clubId",
          c.name "clubName",
          ct.name "tierName",
          ca."userId"
        FROM "ClubMembership" cm
        JOIN "Club" c ON cm."clubId" = c.id
        JOIN "ClubTier" ct ON cm."clubTierId" = ct.id
        JOIN "ClubAdmin" ca ON ca."clubId" = c.id
        WHERE cm."startedAt" > '${lastSent}'
          AND 'ManageMemberships'=ANY(ca.permissions)
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
        SELECT
          REPLACE(gen_random_uuid()::text, '-', ''),
          "userId",
          'club-new-member-joined' "type",
          jsonb_build_object(
            'clubId', "clubId",
            'clubName', "clubName",
            'tierName', "tierName"
          )
        FROM data
      ON CONFLICT("id") DO NOTHING;
    `,
  },
  'club-billing-toggled': {
    displayName: 'Monthly billing for a club you are a member of has been toggled',
    category: 'Update',
    toggleable: false,
    prepareMessage: ({ details }) => {
      return {
        message: `Monthly billing for the club ${details.clubName} has been ${
          details.billing
            ? `enabled. Your next billing will be on ${formatDate(details.nextBillingAt)}.`
            : 'disabled. You will not be charged for this club on a monthly basis anymore.'
        }`,
        url: `/clubs/${details.clubId}`,
      };
    },
  },
  'club-new-post-created': {
    displayName: 'A new club post has been created!',
    category: 'Update',
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `New club post has been added to ${details.name} club.`,
      url: `/clubs/${details.clubId}`,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT
          p.id "clubPostId",
          c.id "clubId",
          c.name "name",
          cm."userId"
        FROM "ClubPost" p
        JOIN "Club" c ON p."clubId" = c.id
        JOIN "ClubMembership" cm ON cm."clubId" = c.id
        WHERE p."createdAt" > '${lastSent}' AND (cm."expiresAt" > NOW() OR cm."expiresAt" IS NULL)
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
        SELECT
          CONCAT("userId",':','club-new-post-created',':',"clubPostId"),
          "userId",
          'club-new-post-created' "type",
          jsonb_build_object(
            'clubId', "clubId",
            'name', "name"
          )
        FROM data
      ON CONFLICT("id") DO NOTHING;
    `,
  },
  'club-new-resource-added': {
    displayName: 'A new club resouce has been created!',
    category: 'Update',
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `New ${
        details.resourceType === 'Post' ? 'Image Post' : getDisplayName(details.resourceType)
      } has been added to ${details.name} club.`,
      url: `/clubs/${details.clubId}`,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH "clubEntities" AS (
        SELECT
          COALESCE(c.id, ct."clubId") "clubId",
          ea."accessToId" "resourceId",
          ea."accessToType" "resourceType",
          COALESCE(c.name, cct.name) "name"
        FROM "EntityAccess" ea
        LEFT JOIN "Club" c ON ea."accessorId" = c.id AND ea."accessorType" = 'Club'
        LEFT JOIN "ClubTier" ct ON ea."accessorId" = ct."id" AND ea."accessorType" = 'ClubTier'
        LEFT JOIN "Club" cct ON ct."clubId" = cct.id
        WHERE COALESCE(c.id, ct."clubId") IS NOT NULL AND ea."addedAt" > '${lastSent}'
      ), data AS (
        SELECT
          ce."clubId",
          ce."resourceId",
          ce."resourceType",
          ce."name",
          cm."userId"
        FROM "clubEntities" ce
        JOIN "ClubMembership" cm ON cm."clubId" = ce."clubId"
        WHERE cm."expiresAt" > NOW() OR cm."expiresAt" IS NULL
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
        SELECT
          CONCAT("userId",':','club-new-resource-added',':',"resourceType",':',"resourceId"),
          "userId",
          'club-new-resource-added' "type",
          jsonb_build_object(
            'clubId', "clubId",
            'name', "name",
            'resourceType', "resourceType"
          )
        FROM data
      ON CONFLICT("id") DO NOTHING;
    `,
  },
});
