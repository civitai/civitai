import { NotificationCategory } from '~/server/common/enums';
import { type UnpublishReason, unpublishReasons } from '~/server/common/moderation-helpers';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { slugit } from '~/utils/string-helpers';

export const unpublishNotifications = createNotificationProcessor({
  // Moveable (maybe)
  'model-version-unpublished': {
    displayName: 'Model version unpublished',
    category: NotificationCategory.System,
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
    prepareQuery: ({ lastSent }) => `
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
      SELECT
        concat('model-version-unpublished:', details->>'modelVersionId', ':', '${lastSent}') "key",
        "userId",
        'model-version-unpublished' "type",
        details
      FROM unpublished;
    `,
  },
  'model-unpublished': {
    displayName: 'Model unpublished',
    category: NotificationCategory.System,
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
    prepareQuery: ({ lastSent }) => `
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
      SELECT
        concat('model-unpublished:', details->>'modelId', ':', '${lastSent}') "key",
        "userId",
        'model-unpublished' "type",
        details
      FROM unpublished;
    `,
  },
  'model-republish-declined': {
    displayName: 'Model republish declined',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => {
      let message = `Your republish request for ${details.modelName} has been declined`;
      if (details.reason) message += `: ${details.reason}`;
      return {
        message,
        url: `/models/${details.modelId}/${slugit(details.modelName)}`,
      };
    },
    prepareQuery: ({ lastSent }) => `
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
      SELECT
        concat('model-republish-declined:', details->>'modelId', ':', '${lastSent}') "key",
        "userId",
        'model-republish-declined' "type",
        details
      FROM declined;
    `,
  },
});
