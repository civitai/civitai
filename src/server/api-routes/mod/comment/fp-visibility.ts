import * as z from 'zod';
import { liftModeratorFpHide } from '@civitai/db-queries/feature-page-comments';
import { constants } from '~/server/common/constants';
import { kyselyWrite } from '~/server/db/kyselyDb';
import { moderatorHideFpComment } from '~/server/services/commentv3/moderation.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

const input = z.discriminatedUnion('hidden', [
  z.object({
    commentId: z.number().int().positive().describe('A Feature Pages comment id.'),
    hidden: z.literal(true),
    seenVersion: z.number().int().positive().describe('The text version the moderator saw.'),
  }),
  z.object({
    commentId: z.number().int().positive(),
    hidden: z.literal(false),
    seenVersion: z.number().int().positive(),
    seenHiddenAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/)
      .describe('The hide the moderator saw: `hiddenAt::text`.'),
    exceptReportId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('The open report the moderator is ruling on, which does not hold the unhide.'),
  }),
]);

export default defineModeratorEndpoint('comment.fpVisibility', {
  summary: 'Hide or unhide one Feature Pages comment as a moderator.',
  returns: '{ hidden: boolean } | { held: reason }',
  notes: [
    'Bound to what the moderator saw: a comment whose text version or hide changed since answers `held: "changed"` and writes nothing.',
    "An unhide lifts a moderator's hide only. The scan's hide is lifted by dismissing its scan report.",
    'The comment shows on the site at once and on the platform after the next daily reconcile.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input,
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
    const r = await liftModeratorFpHide(kyselyWrite, {
      commentId: input.commentId,
      actorId: ctx.actor.id,
      systemUserId: constants.system.user.id,
      seenHiddenAt: input.seenHiddenAt,
      seenVersion: input.seenVersion,
      exceptReportId: input.exceptReportId,
    });
    return 'held' in r ? { held: r.held, affected } : { hidden: false, affected };
  },
});
