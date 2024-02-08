import { commentNotifications } from '~/server/notifications/comment.notifications';
import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { isDefined } from '~/utils/type-guards';

export const commentDetailFetcher = createDetailFetcher({
  types: [...Object.keys(commentNotifications)],
  fetcher: async (notifications, { db }) => {
    const commentIds = notifications
      .map((n) => (n.details.version !== 2 ? (n.details.commentId as number | undefined) : null))
      .filter(isDefined);
    const comments = commentIds.length
      ? await db.comment.findMany({
          where: { id: { in: commentIds } },
          select: { id: true, content: true, user: { select: simpleUserSelect } },
        })
      : [];

    const commentV2Ids = notifications
      .map((n) => (n.details.version === 2 ? (n.details.commentId as number | undefined) : null))
      .filter(isDefined);
    const commentsV2 = commentV2Ids.length
      ? await db.commentV2.findMany({
          where: { id: { in: commentV2Ids } },
          select: { id: true, content: true, user: { select: simpleUserSelect } },
        })
      : [];

    if (comments.length === 0 && commentsV2.length === 0) return;

    for (const n of notifications) {
      const comment = comments.find((c) => c.id === n.details.commentId);
      const commentV2 = commentsV2.find((c) => c.id === n.details.commentId);

      if (comment) {
        n.details.content = comment.content;
        n.details.actor = comment.user;
      }

      if (commentV2) {
        n.details.content = commentV2.content;
        n.details.actor = commentV2.user;
      }
    }
  },
});
