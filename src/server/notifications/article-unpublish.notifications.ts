import { NotificationCategory } from '~/server/common/enums';
import { type UnpublishReason, unpublishReasons } from '~/server/common/moderation-helpers';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const articleUnpublishNotifications = createNotificationProcessor({
  'article-unpublished': {
    displayName: 'Article unpublished',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) =>
      details
        ? {
            message:
              details.reason !== 'other'
                ? `Your article "${details.articleTitle}" has been unpublished: ${
                    unpublishReasons[details.reason as UnpublishReason].notificationMessage ?? ''
                  }`
                : `Your article "${details.articleTitle}" has been unpublished: ${
                    details.customMessage ?? ''
                  }`,
            url: `/articles/${details.articleId}`,
          }
        : undefined,
    prepareQuery: ({ lastSent }) => `
      WITH unpublished AS (
        SELECT DISTINCT
          a."userId",
          jsonb_build_object(
            'articleId', a.id,
            'articleTitle', a.title,
            'reason', a.metadata->>'unpublishedReason',
            'customMessage', a.metadata->>'customMessage'
          ) "details"
        FROM "Article" a
        WHERE jsonb_typeof(a.metadata->'unpublishedReason') = 'string'
          AND (a.metadata->>'unpublishedAt')::timestamp > '${lastSent}'
      )
      SELECT
        concat('article-unpublished:', details->>'articleId', ':', '${lastSent}') "key",
        "userId",
        'article-unpublished' "type",
        details
      FROM unpublished;
    `,
  },
});
