import { bulkSetCommentTosViolation } from '~/server/services/comment.service';
import { bulkSetCommentV2TosViolation } from '~/server/services/commentsv2.service';
import { resolveClientIpOrNull } from '~/server/utils/client-ip';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import {
  commentAffected,
  commentIdSchema,
  ensureAtLeastOneList,
} from '~/server/schema/moderator/comment';

const EMPTY = { count: 0, notified: 0, rewardedReports: 0 };

export default defineModeratorEndpoint('comment.removeAsTos', {
  summary: 'Flag comments as a ToS violation, action their reports and notify the owners.',
  returns: '{ comment, commentV2 } — each { count, notified, rewardedReports }',
  notes: [
    'At least one of the two id lists must be non-empty.',
    'Related TOSViolation reports are actioned, and their reporters rewarded.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: commentIdSchema,
  async handler(input, ctx) {
    ensureAtLeastOneList(input);
    // AUDIT-TRAIL surface: records WHICH moderator acted, alongside their user id. It gates nothing, so
    // it takes the derivation that always yields a label; the fail-closed one would attribute every
    // non-edge moderator to one shared hop and make the trail unable to tell them apart.
    //
    // The `undefined` sentinel is preserved: `actor.ip` is optional and flows into
    // `reportAcceptedReward.apply(…, { ip })`, whose pipeline folds a falsy address away before it can
    // reach a buzz idempotency key. Only WHICH address is recorded changes here.
    const ip = resolveClientIpOrNull(ctx.req) ?? undefined;
    const actor = { id: ctx.actor.id, ip };

    const v1 = input.commentIds?.length
      ? await bulkSetCommentTosViolation({ ids: input.commentIds, actor })
      : EMPTY;
    const v2 = input.commentV2Ids?.length
      ? await bulkSetCommentV2TosViolation({ ids: input.commentV2Ids, actor })
      : EMPTY;

    return { comment: v1, commentV2: v2, affected: commentAffected(input) };
  },
});
