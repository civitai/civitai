import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { simpleUserSelect } from '~/server/selectors/user.selector';

/**
 * Resolves the moderator who wrote a thread reply into `actor`, the name the byline shows and the
 * notification list's avatar, from the stored `messageId`: the author is read off the
 * `app_review_messages` row here, server-side. A deleted or missing account resolves to no
 * actor, so the byline falls back to "From Civitai App Review".
 *
 * The details this returns go to the client verbatim, so no account id is set, and an
 * `authorUserId` stored by an earlier build is removed from every notification in the batch.
 */
export const appReviewReplyDetailFetcher = createDetailFetcher({
  types: ['app-review-reply-to-developer'],
  fetcher: async (notifications, { db }) => {
    for (const n of notifications) delete n.details.authorUserId;

    const messageIds = [
      ...new Set(
        notifications
          .map((n) => n.details.messageId)
          .filter((id): id is number => typeof id === 'number')
      ),
    ];
    if (messageIds.length === 0) return;

    const messages = await db.appReviewMessage.findMany({
      where: { id: { in: messageIds } },
      select: { id: true, author: { select: simpleUserSelect } },
    });

    for (const n of notifications) {
      const author = messages.find((m) => m.id === n.details.messageId)?.author;
      // The byline and avatar need the name and picture only; the account id stays server-side.
      if (author && !author.deletedAt) {
        const { id, ...actor } = author;
        n.details.actor = actor;
      }
    }
  },
});
