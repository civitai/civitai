import { truncate } from 'lodash-es';
import { kyselyRead } from '~/server/db/kyselyDb';
import { commentNotifications } from '~/server/notifications/comment.notifications';
import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { mentionNotifications } from '~/server/notifications/mention.notifications';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { removeTags } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

export const commentDetailFetcher = createDetailFetcher({
  types: [...Object.keys(commentNotifications), ...Object.keys(mentionNotifications)],
  fetcher: async (notifications, { db }) => {
    // Every version reads CommentV3, the one table every write reaches: a v2 comment by its id (ids
    // are preserved), a v1 comment by its old id in `legacyV1Id`, a v3 comment by its id.
    //
    // A removed comment must not keep serving its body here. This runs at READ time, so the preview
    // is re-fetched every time the panel opens — a phishing reply taken down by a moderator (or by a
    // ban's comment purge) otherwise stays legible in every recipient's inbox indefinitely. BOTH
    // flags, because the two takedown paths write different ones: a moderator sets `tosViolation`,
    // while `entity-moderation`'s automated sweep sets `hidden`. A tombstone keeps its row, so it is
    // excluded the same way.
    // A model-page notification (no version, or the v1 shape with one) carries the old Comment id,
    // which a comment written since the shared sequence keeps as its own; every other one the v3 id.
    const legacyKeyed = (n: (typeof notifications)[number]) =>
      !n.details.version || (n.details.modelId !== undefined && n.details.threadType === undefined);
    const byLegacy = notifications.filter(legacyKeyed);
    const byId = notifications.filter((n) => !legacyKeyed(n));
    const legacyIds = byLegacy
      .map((n) => n.details.commentId as number | undefined)
      .filter(isDefined);
    const ids = byId.map((n) => n.details.commentId as number | undefined).filter(isDefined);
    if (!legacyIds.length && !ids.length) return;

    const rows = await kyselyRead
      .selectFrom('CommentV3')
      .select(['id', 'legacyV1Id', 'entityType', 'content', 'userId'])
      .where((eb) =>
        eb.or([
          ...(ids.length ? [eb('id', 'in', ids)] : []),
          ...(legacyIds.length
            ? [
                eb('legacyV1Id', 'in', legacyIds),
                // A model comment with no old id keeps its own as the model page's id; only a model
                // one, or an old v1 id would match an unrelated comment elsewhere with that number.
                eb.and([
                  eb('id', 'in', legacyIds),
                  eb('legacyV1Id', 'is', null),
                  eb('entityType', '=', 'model'),
                ]),
              ]
            : []),
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
        ? rows.find((r) => r.legacyV1Id === n.details.commentId) ??
          rows.find(
            (r) => r.legacyV1Id === null && r.entityType === 'model' && r.id === n.details.commentId
          )
        : rows.find((r) => r.id === n.details.commentId);
      if (!comment) continue;
      n.details.content = truncate(removeTags(comment.content ?? ''), { length: 150 });
      n.details.actor = users.find((u) => u.id === comment.userId);
    }
  },
});
