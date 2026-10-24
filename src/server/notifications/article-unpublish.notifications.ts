import { NotificationCategory } from '~/server/common/enums';
import { getArticleUnpublishReason } from '~/server/common/moderation-helpers';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const articleUnpublishNotifications = createNotificationProcessor({
  'article-unpublished': {
    displayName: 'Article unpublished',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => {
      if (!details) return undefined;

      const reasonCopy =
        details.reason !== 'other'
          ? getArticleUnpublishReason(details.reason)?.notificationMessage
          : details.customMessage;

      return {
        message: reasonCopy
          ? `Your article "${details.articleTitle}" has been unpublished: ${reasonCopy}`
          : `Your article "${details.articleTitle}" has been unpublished.`,
        url: `/articles/${details.articleId}`,
      };
    },
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
