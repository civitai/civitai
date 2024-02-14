import { unpublishReasons, type UnpublishReason } from '~/server/common/moderation-helpers';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { slugit } from '~/utils/string-helpers';

export const unpublishNotifications = createNotificationProcessor({
  'model-version-unpublished': {
    displayName: 'Model version unpublished',
    category: 'System',
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message:
        details.reason !== 'other'
          ? `Your ${details.modelName} - ${details.modelVersionName} model has been unpublished: ${
              unpublishReasons[details.reason as UnpublishReason].notificationMessage ?? ''
            }`
          : `Your ${details.modelName} - ${details.modelVersionName} model has been unpublished: ${
              details.customMessage ?? ''
            }`,
      url: `/models/${details.modelId}/${slugit(details.modelName)}?modelVersionId=${
        details.modelVersionId
      }`,
    }),
    prepareQuery: ({ lastSent, category }) => `
      WITH unpublished AS (
        SELECT DISTINCT
          m."userId",
          jsonb_build_object(
            'modelId', m.id,
            'modelName', m.name,
            'modelVersionId', mv.id,
            'modelVersionName', mv.name,
            'reason', mv.meta->>'unpublishedReason',
            'customMessage', mv.meta->>'customMessage'
          ) "details"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE jsonb_typeof(mv.meta->'unpublishedReason') = 'string'
          AND (mv.meta->>'unpublishedAt')::timestamp > '${lastSent}'
      )
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "userId",
        'model-version-unpublished' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM unpublished;
    `,
  },
  'model-unpublished': {
    displayName: 'Model unpublished',
    category: 'System',
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message:
        details.reason !== 'other'
          ? `Your ${details.modelName} model has been unpublished: ${
              unpublishReasons[details.reason as UnpublishReason].notificationMessage ?? ''
            }`
          : `Your ${details.modelName} model has been unpublished: ${details.customMessage ?? ''}`,
      url: `/models/${details.modelId}/${slugit(details.modelName)}`,
    }),
    prepareQuery: ({ lastSent, category }) => `
      WITH unpublished AS (
        SELECT DISTINCT
          m."userId",
          jsonb_build_object(
            'modelId', m.id,
            'modelName', m.name,
            'reason', m.meta->>'unpublishedReason',
            'customMessage', m.meta->>'customMessage'
          ) "details"
        FROM "Model" m
        WHERE jsonb_typeof(m.meta->'unpublishedReason') = 'string'
          AND (m.meta->>'unpublishedAt')::timestamp > '${lastSent}'
      )
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "userId",
        'model-unpublished' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM unpublished;
    `,
  },
  'model-republish-declined': {
    displayName: 'Model republish declined',
    category: 'System',
    toggleable: false,
    prepareMessage: ({ details }) => {
      let message = `Your republish request for ${details.modelName} has been declined`;
      if (details.reason) message += `: ${details.reason}`;
      return {
        message,
        url: `/models/${details.modelId}/${slugit(details.modelName)}`,
      };
    },
    prepareQuery: ({ lastSent, category }) => `
      WITH declined AS (
        SELECT DISTINCT
          m."userId",
          jsonb_build_object(
            'modelId', m.id,
            'modelName', m.name,
            'reason', m.meta->>'declinedReason'
          ) "details"
        FROM "Model" m
        WHERE jsonb_typeof(m.meta->'declinedReason') = 'string'
          AND (m.meta->>'declinedAt')::timestamp > '${lastSent}'
      )
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "userId",
        'model-republish-declined' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM declined;
    `,
  },
});
