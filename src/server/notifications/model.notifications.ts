import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { getDisplayName, slugit } from '~/utils/string-helpers';

const modelDownloadMilestones = [5, 10, 20, 50, 100, 500] as const;
const modelLikeMilestones = [100, 500, 1000, 10000, 50000] as const;

export const modelNotifications = createNotificationProcessor({
  'model-download-milestone': {
    displayName: 'Model download milestones',
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your ${details.modelName} model has received ${details.downloadCount} downloads`,
      url: `/models/${details.modelId}`,
    }),
    prepareQuery: async ({ lastSent, clickhouse }) => {
      const affected = (await clickhouse
        ?.query({
          query: `
            SELECT DISTINCT modelId
            FROM modelVersionEvents
            WHERE time > parseDateTimeBestEffortOrNull('${lastSent}')
            AND type = 'Download'
        `,
          format: 'JSONEachRow',
        })
        .then((x) => x.json())) as [{ modelId: number }];

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
            AND "downloadCount" > ${modelDownloadMilestones[0]}
            AND timeframe = 'AllTime'
        ), prior_milestones AS (
          SELECT DISTINCT
            model_id,
            cast(details->'downloadCount' as int) download_count
          FROM "Notification"
          JOIN model_value ON model_id = cast(details->'modelId' as int)
          WHERE type = 'model-download-milestone'
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
          LEFT JOIN prior_milestones pm ON pm.download_count >= ms.value AND pm.model_id = mval.model_id
          WHERE pm.model_id IS NULL
        )
        INSERT INTO "Notification"("id", "userId", "type", "details")
        SELECT
          REPLACE(gen_random_uuid()::text, '-', ''),
          "ownerId"    "userId",
          'model-download-milestone' "type",
          details
        FROM model_milestone
        WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'model-download-milestone');
      `;
    },
  },
  'model-like-milestone': {
    displayName: 'Model like milestones',
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your ${details.modelName} model has received ${details.favoriteCount} likes`,
      url: `/models/${details.modelId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH milestones AS (
        SELECT * FROM (VALUES ${modelLikeMilestones.map((x) => `(${x})`).join(', ')}) m(value)
      ), affected_models AS (
        SELECT DISTINCT
          "modelId" model_id
        FROM "ModelEngagement" fm
        JOIN "Model" m ON fm."modelId" = m.id
        WHERE fm."createdAt" > '${lastSent}' AND fm.type = 'Favorite'
        AND m."userId" > 0
      ), model_value AS (
        SELECT
          "modelId" model_id,
          "favoriteCountAllTime" favorite_count
        FROM "ModelRank" mr
        JOIN affected_models am ON am.model_id = mr."modelId"
        WHERE "favoriteCountAllTime" > ${modelLikeMilestones[0]}
      ), prior_milestones AS (
        SELECT DISTINCT
          model_id,
          cast(details->'favoriteCount' as int) favorite_count
        FROM "Notification"
        JOIN affected_models ON model_id = cast(details->'modelId' as int)
        WHERE type = 'model-like-milestone'
      ), model_milestone AS (
        SELECT
          m."userId" "ownerId",
          JSON_BUILD_OBJECT(
            'modelName', m.name,
            'modelId', m.id,
            'favoriteCount', ms.value
          ) "details"
        FROM model_value mval
        JOIN "Model" m on m.id = mval.model_id
        JOIN milestones ms ON ms.value <= mval.favorite_count
        LEFT JOIN prior_milestones pm ON pm.favorite_count >= ms.value AND pm.model_id = mval.model_id
        WHERE pm.model_id IS NULL
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'model-like-milestone' "type",
        details
      FROM model_milestone
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'model-like-milestone');
    `,
  },
  'new-model-version': {
    displayName: 'New versions of liked models',
    prepareMessage: ({ details }) => ({
      message: `The ${details.modelName} model you liked has a new version: ${details.versionName}`,
      url: `/models/${details.modelId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_model_version AS (
        SELECT DISTINCT
          fm."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'modelId', mv."modelId",
            'modelName', m.name,
            'versionName', mv.name,
            'modelVersionId', mv.id
          ) "details"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        JOIN "ModelEngagement" fm ON m.id = fm."modelId" AND mv."publishedAt" >= fm."createdAt" AND fm.type = 'Favorite'
        WHERE (mv."publishedAt" >= '${lastSent}' AND mv.status = 'Published')
        OR (mv."publishedAt" <= '${lastSent}' AND mv.status = 'Scheduled')
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-model-version' "type",
        details
      FROM new_model_version
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-model-version');
    `,
  },
  'new-model-from-following': {
    displayName: 'New models from followed users',
    prepareMessage: ({ details }) => ({
      message: `${details.username} released a new ${getDisplayName(
        details.modelType
      ).toLowerCase()}: ${details.modelName}`,
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
          (m."publishedAt" >= '${lastSent}' AND m.status = 'Published')
        OR (m."publishedAt" <= '${lastSent}' AND m.status = 'Scheduled')
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-model-from-following' "type",
        details
      FROM new_model_from_following
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-model-from-following');
    `,
  },
  'early-access-complete': {
    toggleable: false,
    displayName: 'Early Access Complete',
    prepareMessage: ({ details }) => ({
      message: `${details.modelName}: ${details.versionName} has left Early Access!`,
      url: `/models/${details.modelId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      -- early access complete
      WITH early_access_versions AS (
        SELECT
          mv.id version_id,
          mv.name version_name,
          m.id model_id,
          m.name model_name,
          m.type model_type,
          GREATEST(mv."createdAt", m."publishedAt") + interval '1' day * mv."earlyAccessTimeFrame" early_access_deadline
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        where "earlyAccessTimeFrame" != 0
        AND m."publishedAt" IS NOT NULL
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
        WHERE ev.early_access_deadline > '${lastSent}' AND ev.early_access_deadline < now()
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        owner_id,
        'early-access-complete',
        details
      FROM early_access_complete;
    `,
  },
  'model-old-draft': {
    displayName: 'Old Model Draft Deletion Reminder',
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Your ${details.modelName} model that is in draft mode will be deleted in 1 week.`,
      url: `/models/${details.modelId}/${slugit(details.modelName)}`,
    }),
    prepareQuery: () => `
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
        AND m."updatedAt" < now() - INTERVAL '23 days'
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "userId",
        'old-draft',
        details
      FROM to_add
      WHERE NOT EXISTS (SELECT 1 FROM "Notification" no WHERE no."userId" = to_add."userId" AND type = 'old-draft' AND no.details->>'modelId' = to_add.details->>'modelId');
    `,
  },
});
