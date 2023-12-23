import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { getDisplayName } from '../../utils/string-helpers';

export const clubNotifications = createNotificationProcessor({
  'club-new-member-joined': {
    displayName: 'New Member Joined your club!',
    prepareMessage: ({ details }) => {
      return {
        message: `A new user has joined your club!`,
        url: `/clubs/${details.clubId}`,
      };
    },
  },
  'club-new-post-created': {
    displayName: 'A new club post has been created!',
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
        LEFT JOIN "ClubTier" ct ON ea."accessorId" = ct."clubId" AND ea."accessorType" = 'ClubTier'
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
