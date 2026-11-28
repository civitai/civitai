import {
  moderatorHideFpComment,
  moderatorUnhideFpComment,
} from '~/server/services/commentv3/moderation.service';
import { fpVisibilitySchema } from '~/server/schema/moderator/comment';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('comment.fpVisibility', {
  summary: 'Hide or unhide one Feature Pages comment as a moderator.',
  returns: '{ hidden: boolean } | { held: reason }',
  notes: [
    'Bound to what the moderator saw: a comment whose text version or hide changed since answers `held: "changed"` and writes nothing.',
    "An unhide lifts a moderator's hide only. The scan's hide is lifted by dismissing its scan report.",
    'An unhide is made only over a finished clean scan of the current text (`held: "scanning"` or `"flagged"` otherwise).',
    'The comment shows on the site at once and on the platform after the next daily reconcile.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: fpVisibilitySchema,
  async handler(input, ctx) {
    const affected = { commentIds: [input.commentId] };
    if (input.hidden) {
      const r = await moderatorHideFpComment({
        commentId: input.commentId,
        seenVersion: input.seenVersion,
        actorId: ctx.actor.id,
      });
      return { ...r, affected };
    }
    const r = await moderatorUnhideFpComment({
      commentId: input.commentId,
      actorId: ctx.actor.id,
      seenHiddenAt: input.seenHiddenAt,
      seenVersion: input.seenVersion,
      exceptReportId: input.exceptReportId,
    });
    return 'held' in r ? { held: r.held, affected } : { hidden: false, affected };
  },
});
