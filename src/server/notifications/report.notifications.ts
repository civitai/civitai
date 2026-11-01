import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { EntityType } from '~/shared/utils/prisma/enums';
import type { OrphanedAppealOutcome } from '~/shared/utils/appeal';
import {
  isSiteAppealCategory,
  siteAppealDecisionText,
  SITE_APPEAL_PATH,
  type SiteAppealCategory,
} from '@civitai/shared/site-appeal';

const entityUrlMap: Partial<{ [k in EntityType]?: string }> = {
  [EntityType.Image]: '/images',
  [EntityType.Model]: '/models',
  [EntityType.Bounty]: '/bounties',
  [EntityType.Storyline]: '/storylines',
} as const;

function siteAppealResolvedMessage(details: {
  category: SiteAppealCategory;
  status: string;
  entityId: number;
  restored?: boolean;
  resolvedMessage?: string;
}) {
  const approved = details.status === 'Approved';
  const restored = approved && details.restored === true;
  const text = siteAppealDecisionText({ category: details.category, approved, restored });
  const note = details.resolvedMessage ? ` Moderator's note: ${details.resolvedMessage}` : '';
  const url =
    restored && details.category === 'Article'
      ? `/articles/${details.entityId}`
      : restored && details.category === 'Model'
      ? `/models/${details.entityId}`
      : SITE_APPEAL_PATH;
  return { message: `${text}${note}`, url };
}

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
                WHEN EXISTS (SELECT 1 FROM "CommentV3Report" WHERE "reportId" = r.id) THEN 'comment'
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
          u."bannedAt" IS NULL AND
          u."deletedAt" IS NULL AND
          -- Never tell an owner that their own reported image was actioned.
          NOT EXISTS (
            SELECT 1 FROM "ImageReport" ir JOIN "Image" i ON i.id = ir."imageId"
            WHERE ir."reportId" = r.id AND i."userId" = u.id
          ) AND
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
    category: NotificationCategory.Moderation,
    toggleable: false,
    prepareMessage: ({ details }) => {
      // Sent by the moderator app's site-appeal queues; every other sender omits `category`.
      if (isSiteAppealCategory(details.category))
        return siteAppealResolvedMessage({
          category: details.category,
          status: details.status,
          entityId: details.entityId,
          restored: details.restored,
          resolvedMessage: details.resolvedMessage,
        });
      return {
        message: `Your appeal regarding your ${
          details.entityType
        } has been ${details.status.toLowerCase()}${
          details.resolvedMessage ? `: ${details.resolvedMessage}.` : '.'
        }`,
        url: `${entityUrlMap[details.entityType as EntityType]}/${details.entityId}`,
      };
    },
  },
  'entity-appeal-content-removed': {
    displayName: 'Appealed content removed',
    category: NotificationCategory.Moderation,
    toggleable: false,
    prepareMessage: ({ details }) => {
      const entity = String(details.entityType).toLowerCase();
      const refund = details.refunded ? ' Your appeal fee has been refunded.' : '';
      const note = details.resolvedMessage ? ` ${details.resolvedMessage}` : '';
      switch (details.outcome as OrphanedAppealOutcome) {
        case 'closed-owner-deleted':
          return { message: `Your appeal was closed because you deleted the ${entity}.${refund}` };
        case 'closed-unreviewed':
          return {
            message: `We couldn't review your appeal in time: the ${entity} was removed before a moderator reached it, so your appeal was closed.${refund}`,
          };
        case 'reviewed-approved':
          return {
            message: `We reviewed your appeal: the ${entity} should not have been removed. It can't be restored, but you're welcome to upload it again.${refund}${note}`,
          };
        case 'reviewed-rejected':
          return {
            message: `We reviewed your appeal: the removal of your ${entity} stands.${note}`,
          };
        case 'under-review':
          return {
            message: `The ${entity} you appealed was removed before a moderator could review it. Your appeal is still open and will be reviewed; we'll let you know the outcome.`,
          };
        // Senders release separately; an outcome this copy predates must not claim the appeal is open.
        default:
          return { message: `There is an update on your appeal about a removed ${entity}.` };
      }
    },
  },
});
