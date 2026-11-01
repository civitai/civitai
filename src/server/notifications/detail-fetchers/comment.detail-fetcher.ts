import { truncate } from 'lodash-es';
import { kyselyRead } from '~/server/db/kyselyDb';
import { commentNotifications } from '~/server/notifications/comment.notifications';
import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { mentionNotifications } from '~/server/notifications/mention.notifications';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { removeTags } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

const MODEL_PAGE_TYPES = new Set(['new-comment', 'new-comment-response', 'new-comment-nested']);
const BOTH_SHAPE_TYPES = new Set(['new-thread-response', 'new-mention']);

export const commentDetailFetcher = createDetailFetcher({
  types: [...Object.keys(commentNotifications), ...Object.keys(mentionNotifications)],
  fetcher: async (notifications, { db }) => {
    // A removed comment must not keep serving its body here. This runs at READ time, so the preview
    // is re-fetched every time the panel opens — a phishing reply taken down by a moderator (or by a
    // ban's comment purge) otherwise stays legible in every recipient's inbox indefinitely. BOTH
    // flags, because the two takedown paths write different ones: a moderator sets `tosViolation`,
    // while `entity-moderation`'s automated sweep sets `hidden`. A tombstone keeps its row, so it is
    // excluded the same way.
    // A model-page notification carries the old Comment id, which a comment written since the shared
    // sequence keeps as its own; every other one the comment's id. Versionless rows are all v1. A
    // versioned one is model-page by its type, and for the two types that emit both shapes by the
    // missing threadType — not by `modelId`, which new-image-comment and new-review-response carry too.
    const legacyKeyed = (n: (typeof notifications)[number]) =>
      !n.details.version ||
      MODEL_PAGE_TYPES.has(n.type) ||
      (BOTH_SHAPE_TYPES.has(n.type) && n.details.threadType === undefined);
    const byLegacy = notifications.filter(legacyKeyed);
    const byId = notifications.filter((n) => !legacyKeyed(n));
    const legacyIds = byLegacy
      .map((n) => n.details.commentId as number | undefined)
      .filter(isDefined);
    const ids = byId.map((n) => n.details.commentId as number | undefined).filter(isDefined);
    if (!legacyIds.length && !ids.length) return;

    const rows = await kyselyRead
      .selectFrom('CommentV3')
      .select(['id', 'legacyV1Id', 'content', 'userId'])
      .where((eb) =>
        eb.or([
          ...(ids.length ? [eb('id', 'in', ids)] : []),
          ...(legacyIds.length ? [eb('legacyV1Id', 'in', legacyIds)] : []),
        ])
      )
      .where('tosViolation', '=', false)
      .where('hidden', '=', false)
      .where('deletedAt', 'is', null)
      .execute();
    if (!rows.length) return;
    const users = await db.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
      select: simpleUserSelect,
    });

    for (const n of notifications) {
      const comment = legacyKeyed(n)
        ? rows.find((r) => r.legacyV1Id === n.details.commentId)
        : rows.find((r) => r.id === n.details.commentId);
      if (!comment) continue;
      n.details.content = truncate(removeTags(comment.content ?? ''), { length: 150 });
      n.details.actor = users.find((u) => u.id === comment.userId);
    }
  },
});
