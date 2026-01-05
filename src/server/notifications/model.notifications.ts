import { milestoneNotificationFix } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { getDisplayName, slugit } from '~/utils/string-helpers';

const modelDownloadMilestones = [5, 10, 20, 50, 100, 500] as const;
const modelLikeMilestones = [100, 500, 1000, 10000, 50000] as const;

export const modelNotifications = createNotificationProcessor({
  'model-download-milestone': {
    displayName: 'Model download milestones',
    category: NotificationCategory.Milestone,
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your ${
        details.modelName
      } model has received ${details.downloadCount.toLocaleString()} downloads`,
      url: `/models/${details.modelId}`,
    }),
    prepareQuery: async ({ lastSentDate, clickhouse }) => {
      if (!clickhouse) return;
      const affected = await clickhouse.$query<{ modelId: number }>`
        SELECT DISTINCT modelId
        FROM modelVersionEvents
        WHERE time > ${lastSentDate}
        AND type = 'Download'
      `;

      const affectedJson = JSON.stringify(affected.map((x) => x.modelId));
      return `
        WITH milestones AS (
          SELECT * FROM (VALUES ${modelDownloadMilestones.map((x) => `(${x})`).join(', ')}) m(value)
        ), model_value AS (
          SELECT
            "modelId" model_id,
            "downloadCount" download_count
          FROM "ModelMetric"
          WHERE
            "modelId" = ANY (SELECT json_array_elements('${affectedJson}'::json)::text::integer)
            AND "downloadCount" >= ${modelDownloadMilestones[0]}
        ), model_milestone AS (
          SELECT
            m."userId" "ownerId",
            JSON_BUILD_OBJECT(
              'modelName', m.name,
              'modelId', m.id,
              'downloadCount', ms.value
            ) "details"
          FROM model_value mval
          JOIN "Model" m on m.id = mval.model_id
          JOIN milestones ms ON ms.value <= mval.download_count
          WHERE m."createdAt" > '${milestoneNotificationFix}'
        )
        SELECT
          CONCAT('model-download-milestone:', details->>'modelId', ':', details->>'downloadCount') as "key",
          "ownerId"    "userId",
          'model-download-milestone' "type",
          details
        FROM model_milestone
        WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'model-download-milestone')
      `;
    },
  },
  'model-like-milestone': {
    displayName: 'Model like milestones',
    category: NotificationCategory.Milestone,
    prepareMessage: ({ details }) => {
      const count = details.favoriteCount || details.thumbsUpCount;

      return {
        message: `Congrats! Your ${
          details.modelName
        } model has received ${count?.toLocaleString()} likes`,
        url: `/models/${details.modelId}`,
      };
    },
    prepareQuery: ({ lastSent }) => `
      WITH milestones AS (
        SELECT * FROM (VALUES ${modelLikeMilestones.map((x) => `(${x})`).join(', ')}) m(value)
      ), model_value AS (
        SELECT DISTINCT
          mm."modelId" model_id,
          mm."thumbsUpCount" thumbs_up_count
        FROM "ModelMetric" mm
        JOIN "Model" m ON m.id = mm."modelId"
        WHERE
          mm."updatedAt" > '${lastSent}'
          AND "thumbsUpCount" >= ${modelLikeMilestones[0]}
          AND m."userId" > 0
      ), model_milestone AS (
        SELECT
          m."userId" "ownerId",
          JSON_BUILD_OBJECT(
            'modelName', m.name,
            'modelId', m.id,
            'thumbsUpCount', ms.value
          ) "details"
        FROM model_value mval
        JOIN "Model" m on m.id = mval.model_id
        JOIN milestones ms ON ms.value <= mval.thumbs_up_count
        WHERE m."createdAt" > '${milestoneNotificationFix}'
      )
      SELECT
        CONCAT('model-like-milestone:', details->>'modelId', ':', details->>'thumbsUpCount') "key",
        "ownerId"    "userId",
        'model-like-milestone' "type",
        details
      FROM model_milestone
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'model-like-milestone')
    `,
  },
  // Moveable
  'new-model-version': {
    displayName: 'New versions of models you follow',
    category: NotificationCategory.Update,
    prepareMessage: ({ details }) => ({
      message: `The ${details.modelName} model has a new version: ${details.versionName}`,
      url: `/models/${details.modelId}${
        details.modelVersionId ? `?modelVersionId=${details.modelVersionId}` : ''
      }`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_model_version AS (
        SELECT
          m."userId",
          mv."modelId",
          JSONB_BUILD_OBJECT(
            'modelId', mv."modelId",
            'modelName', m.name,
            'versionName', mv.name,
            'modelVersionId', mv.id
          ) "details"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE m."userId" > 0
          AND mv."publishedAt" - m."publishedAt" > INTERVAL '2 hour'
          AND (
            -- handle scheduled posts - these can take a little while to update via another job
            (mv."publishedAt" BETWEEN '${lastSent}'::timestamptz - interval '59 second' AND now() AND mv.status = 'Published')
            OR (mv."publishedAt" <= '${lastSent}' AND mv.status = 'Scheduled')
          )
      ), followers AS (
        SELECT DISTINCT ON ("userId")
          *
        FROM (
          SELECT
            ue."userId",
            nmv.details
          FROM "UserEngagement" ue
          JOIN new_model_version nmv ON nmv."userId" = ue."targetUserId"
          WHERE ue.type = 'Follow'
            AND NOT EXISTS (SELECT 1 FROM "ModelEngagement" me WHERE me.type = 'Mute' AND me."userId" = ue."userId" AND me."modelId" = nmv."modelId")

          UNION

          SELECT
            me."userId",
            nmv.details
          FROM "ModelEngagement" me
          JOIN new_model_version nmv ON nmv."modelId" = me."modelId"
          WHERE type = 'Notify'
        ) t
      )
      SELECT
        CONCAT('new-model-version:', details->>'modelVersionId') "key",
        "userId",
        'new-model-version' "type",
        details
      FROM followers n
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" uns WHERE uns."userId" = n."userId" AND type = 'new-model-version')
    `,
  },
  // Moveable
  'new-model-from-following': {
    displayName: 'New models from followed users',
    category: NotificationCategory.Update,
    prepareMessage: ({ details }) => ({
      message: `${details.username} released a new ${getDisplayName(details.modelType)}: ${
        details.modelName
      }`,
      url: `/models/${details.modelId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_model_from_following AS (
        SELECT DISTINCT
          ue."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'modelId', m."id",
            'modelName', m.name,
            'username', u.username,
            'modelType', m.type
          ) "details"
        FROM "Model" m
        JOIN "User" u ON u.id = m."userId"
        JOIN "UserEngagement" ue ON ue."targetUserId" = m."userId" AND m."publishedAt" >= ue."createdAt" AND ue.type = 'Follow'
        WHERE
          m."userId" != -1
          AND m."publishedAt" BETWEEN '${lastSent}' AND now()
          AND m.status IN ('Published', 'Scheduled')
      )
      SELECT
        CONCAT('new-model-from-following:', details->>'modelId') "key",
        "ownerId"    "userId",
        'new-model-from-following' "type",
        details
      FROM new_model_from_following
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-model-from-following')
    `,
  },
  'early-access-complete': {
    toggleable: false,
    displayName: 'Early Access Complete',
    category: NotificationCategory.Update,
    prepareMessage: ({ details }) => ({
      message: `${details.modelName}: ${details.versionName} has left Early Access!`,
      url: `/models/${details.modelId}?modelVersionId=${details.versionId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH early_access_versions AS (
         SELECT
          mv.id version_id,
          mv.name version_name,
          m.id model_id,
          m.name model_name,
          m.type model_type,
          mv."publishedAt" updated_published_at
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        where
          (mv."earlyAccessConfig"->>'originalTimeframe')::int > 0
        AND mv."publishedAt" >= '${lastSent}'
      ), early_access_complete AS (
        SELECT DISTINCT
          mve."userId" owner_id,
          jsonb_build_object(
            'modelId', model_id,
            'modelName', model_name,
            'modelType', model_type,
            'versionId', version_id,
            'versionName', version_name
          ) details
        FROM early_access_versions ev
        JOIN "ModelVersionEngagement" mve ON mve."modelVersionId" = ev.version_id AND mve.type = 'Notify'
        WHERE ev.updated_published_at > '${lastSent}' AND ev.updated_published_at < now()
      )
      SELECT
        concat('early-access-complete:', details->>'versionId') "key",
        owner_id "userId",
        'early-access-complete' "type",
        details
      FROM early_access_complete;
    `,
  },
  'old-draft': {
    displayName: 'Old Model Draft Deletion Reminder',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Your ${details.modelName} model that is in draft mode will be deleted in 1 week.`,
      url: `/models/${details.modelId}/${slugit(details.modelName)}`,
    }),
    prepareQuery: ({ lastSent }) => `
      with to_add AS (
        SELECT DISTINCT
          m."userId",
          jsonb_build_object(
            'modelId', m.id,
            'modelName', m.name,
            'updatedAt', m."updatedAt"
          ) details
        FROM "Model" m
        WHERE m.status IN ('Draft')
        AND m."updatedAt" BETWEEN '${lastSent}'::timestamp - INTERVAL '23 days' AND NOW() - INTERVAL '23 days'
      )
      SELECT
        concat('old-draft:', details->>'modelId', ':', details->>'updatedAt') "key",
        "userId",
        'old-draft' "type",
        details
      FROM to_add
    `,
  },

  'early-access-failed-to-publish': {
    displayName: 'Model version failed to publish.',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `We were unable to publish your model version: ${details.displayName} due to insufficient funds. Please remove early access or purchase more Buzz to publish.`,
      url: `/models/${details.modelId}?modelVersionId=${details.modelVersionId}`,
    }),
  },
  'model-hash-fix': {
    displayName: 'Model Hash Fix',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `The hash in the metadata of your resource "${details.modelName}: ${details.versionName}" has been corrected. Please redownload it to ensure that your images report the correct hash going forward.`,
      url: `/models/${details.modelId}/${slugit(details.modelName)}?modelVersionId=${
        details.versionId
      }`,
    }),
  },
});
