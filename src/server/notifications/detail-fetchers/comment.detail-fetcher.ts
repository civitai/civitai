import { commentNotifications } from '~/server/notifications/comment.notifications';
import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { isDefined } from '~/utils/type-guards';

export const commentDetailFetcher = createDetailFetcher({
  types: [...Object.keys(commentNotifications)],
  fetcher: async (notifications, { db }) => {
    const commentIds = notifications
      .map((n) => n.details.commentId as number | undefined)
      .filter(isDefined);
    const comments = await db.comment.findMany({
      where: { id: { in: commentIds } },
      select: { id: true, content: true },
    });

    for (const n of notifications) {
      const comment = comments.find((c) => c.id === n.details.commentId);
      if (comment) n.details.content = comment.content;
    }
  },
});
