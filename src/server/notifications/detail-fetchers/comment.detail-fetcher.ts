import { truncate } from 'lodash-es';
import { commentNotifications } from '~/server/notifications/comment.notifications';
import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { mentionNotifications } from '~/server/notifications/mention.notifications';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { removeTags } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

export const commentDetailFetcher = createDetailFetcher({
  types: [...Object.keys(commentNotifications), ...Object.keys(mentionNotifications)],
  fetcher: async (notifications, { db }) => {
    const commentIds = notifications
      .map((n) => (n.details.version !== 2 ? (n.details.commentId as number | undefined) : null))
      .filter(isDefined);
    // A removed comment must not keep serving its body here. This runs at READ time, so the preview
    // is re-fetched every time the panel opens — a phishing reply taken down by a moderator (or by a
    // ban's comment purge) otherwise stays legible in every recipient's inbox indefinitely.
    const comments = commentIds.length
      ? await db.comment.findMany({
          where: { id: { in: commentIds }, tosViolation: false },
          select: { id: true, content: true, user: { select: simpleUserSelect } },
        })
      : [];

    const commentV2Ids = notifications
      .map((n) => (n.details.version === 2 ? (n.details.commentId as number | undefined) : null))
      .filter(isDefined);
    const commentsV2 = commentV2Ids.length
      ? await db.commentV2.findMany({
          where: { id: { in: commentV2Ids }, tosViolation: false },
          select: { id: true, content: true, user: { select: simpleUserSelect } },
        })
      : [];

    if (comments.length === 0 && commentsV2.length === 0) return;

    for (const n of notifications) {
      const comment = comments.find((c) => c.id === n.details.commentId);
      const commentV2 = commentsV2.find((c) => c.id === n.details.commentId);

      if (comment) {
        n.details.content = truncate(removeTags(comment.content ?? ''), { length: 150 });
        n.details.actor = comment.user;
      }

      if (commentV2) {
        n.details.content = truncate(removeTags(commentV2.content ?? ''), { length: 150 });
        n.details.actor = commentV2.user;
      }
    }
  },
});
