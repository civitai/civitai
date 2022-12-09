import { createNotificationProcessor } from '~/server/notifications/base.notifications';

const modelDownloadMilestones = [5, 10, 20, 50, 100, 500] as const;
const modelLikeMilestones = [100, 500, 1000, 10000, 50000] as const;

export const modelNotifications = createNotificationProcessor({
  'model-download-milestone': {
    displayName: 'Model Download Milestones',
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your ${details.modelName} has recieved ${details.downloadCount} downloads`,
      url: `/model/${details.modelId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH milestones AS (
        SELECT * FROM (VALUES ${modelDownloadMilestones.map((x) => `(${x})`).join(', ')}) m(value)
      ), affected_models AS (
        SELECT DISTINCT
          cast(ua.details->'modelId' as int) model_id
        FROM "UserActivity" ua
        JOIN "Model" m ON cast(ua.details->'modelId' as int) = m.id
        WHERE ua."createdAt" > '${lastSent}'
        AND ua.activity = 'ModelDownload'
        AND m."userId" > 0
      ), model_value AS (
        SELECT
          "modelId" model_id,
          "downloadCountAllTime" download_count
        FROM "ModelRank" mr
        JOIN affected_models am ON am.model_id = mr."modelId"
        WHERE "downloadCountAllTime" > ${modelDownloadMilestones[0]}
      ), prior_milestones AS (
        SELECT DISTINCT
          model_id,
          cast(details->'downloadCount' as int) download_count
        FROM "Notification"
        JOIN affected_models ON model_id = cast(details->'modelId' as int)
        WHERE type = 'model-like-milestone'
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
      FROM model_milestone;
    `,
  },
  'model-like-milestone': {
    displayName: 'Model Like Milestones',
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your ${details.modelName} has recieved ${details.favoriteCount} likes`,
      url: `/model/${details.modelId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH milestones AS (
        SELECT * FROM (VALUES ${modelLikeMilestones.map((x) => `(${x})`).join(', ')}) m(value)
      ), affected_models AS (
        SELECT DISTINCT
          "modelId" model_id
        FROM "FavoriteModel" fm
        JOIN "Model" m ON fm."modelId" = m.id
        WHERE fm."createdAt" > '${lastSent}'
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
      FROM model_milestone;
    `,
  },
  'new-model-version': {
    displayName: 'New Versions of Liked Models',
    prepareMessage: ({ details }) => ({
      message: `The ${details.modelName} model you liked has a new version: ${details.versionName}`,
      url: `/model/${details.modelId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_model_version AS (
        SELECT DISTINCT
          fm."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'modelId', mv."modelId",
            'modelName', m.name,
            'versionName', mv.name
          ) "details"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        JOIN "FavoriteModel" fm ON m.id = fm."modelId"
        WHERE mv."createdAt" > '${lastSent}'
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-model-version' "type",
        details
      FROM new_model_version;
    `,
  },
});
