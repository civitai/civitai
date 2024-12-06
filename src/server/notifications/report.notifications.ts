import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { EntityType } from '~/shared/utils/prisma/enums';

const entityUrlMap: Partial<{ [k in EntityType]?: string }> = {
  [EntityType.Image]: '/images',
} as const;

export const reportNotifications = createNotificationProcessor({
  // Moveable
  'report-actioned': {
    displayName: 'Report actioned',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `The ${
        details.reportType ?? 'item'
      } you reported has been actioned. Thanks for helping keep the community safe!`,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH actioned AS (
        SELECT DISTINCT
          u."id" "ownerId",
          JSONB_BUILD_OBJECT(
            'reportId', r.id,
            'reportType',
              CASE
                WHEN jsonb_typeof(r.details->'reportType') = 'string' THEN r.details->>'reportType'
                WHEN EXISTS (SELECT 1 FROM "ResourceReviewReport" WHERE "reportId" = r.id) THEN 'review'
                WHEN EXISTS (SELECT 1 FROM "ModelReport" WHERE "reportId" = r.id) THEN 'resource'
                WHEN EXISTS (SELECT 1 FROM "CommentReport" WHERE "reportId" = r.id) THEN 'comment'
                WHEN EXISTS (SELECT 1 FROM "CommentV2Report" WHERE "reportId" = r.id) THEN 'comment'
                WHEN EXISTS (SELECT 1 FROM "ImageReport" WHERE "reportId" = r.id) THEN 'image'
                WHEN EXISTS (SELECT 1 FROM "ArticleReport" WHERE "reportId" = r.id) THEN 'article'
                WHEN EXISTS (SELECT 1 FROM "PostReport" WHERE "reportId" = r.id) THEN 'post'
                WHEN EXISTS (SELECT 1 FROM "CollectionReport" WHERE "reportId" = r.id) THEN 'collection'
              END,
            'reportReason', r.reason,
            'createdAt', r."createdAt"
          ) as "details"
        FROM "Report" r
        JOIN "User" u ON u.id = r."userId" OR u.id = ANY(r."alsoReportedBy")
        WHERE
          r."userId" > 0 AND
          r.reason != 'NSFW' AND
          r."statusSetAt" > '${lastSent}' AND
          r.status = 'Actioned'
      )
      SELECT
        concat('report-actioned:', details->>'reportId') "key",
        "ownerId"    "userId",
        'report-actioned' "type",
        details
      FROM actioned r
    `,
  },
  'entity-appeal-resolved': {
    displayName: 'Entity appeal resolved',
    category: NotificationCategory.Other,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Your appeal regarding your ${
        details.entityType
      } has been ${details.status.toLowerCase()}${
        details.resolvedMessage ? `: ${details.resolvedMessage}.` : '.'
      }`,
      url: `${entityUrlMap[details.entityType as EntityType]}/${details.entityId}`,
    }),
  },
});
