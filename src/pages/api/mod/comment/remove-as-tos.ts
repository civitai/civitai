import { bulkSetCommentV3TosViolation } from '~/server/services/commentv3/moderation.service';
import { resolveClientIpOrNull } from '~/server/utils/client-ip';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { commentAffected, commentIdSchema } from '~/server/schema/moderator/comment';

export default defineModeratorEndpoint('comment.removeAsTos', {
  summary: 'Flag comments as a ToS violation, action their reports and notify the owners.',
  returns: '{ comments: { count, notified, rewardedReports } }',
  notes: ['Related TOSViolation reports are actioned, and their reporters rewarded.'],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: commentIdSchema,
  async handler(input, ctx) {
    // AUDIT-TRAIL surface: records WHICH moderator acted, alongside their user id. It gates nothing, so
    // it takes the derivation that always yields a label; the fail-closed one would attribute every
    // non-edge moderator to one shared hop and make the trail unable to tell them apart.
    //
    // The `undefined` sentinel is preserved: `actor.ip` is optional and flows into
    // `reportAcceptedReward.apply(…, { ip })`, whose pipeline folds a falsy address away before it can
    // reach a buzz idempotency key. Only WHICH address is recorded changes here.
    const ip = resolveClientIpOrNull(ctx.req) ?? undefined;
    const actor = { id: ctx.actor.id, ip };

    const comments = await bulkSetCommentV3TosViolation({ ids: input.commentIds, actor });
    return { comments, affected: commentAffected(input) };
  },
});
