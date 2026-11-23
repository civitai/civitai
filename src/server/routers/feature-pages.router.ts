import { CacheTTL } from '~/server/common/constants';
import { rateLimit } from '~/server/middleware.trpc';
import { COMMENT_V3_RATE_LIMIT_KEY, commentRateLimits } from '~/server/schema/commentv3.schema';
import {
  featurePageCommentEditSchema,
  featurePageCommentReportSchema,
  featurePageCommentRetractSchema,
  featurePageCommentSchema,
  featurePageMineSchema,
  featurePageVoteSchema,
} from '~/server/schema/feature-pages.schema';
import {
  castFeaturePageVote,
  getMyFeaturePageVotes,
} from '~/server/services/feature-pages.service';
import {
  editFeaturePageComment,
  postFeaturePageComment,
  reportFeaturePageComment,
  retractFeaturePageComment,
} from '~/server/services/feature-pages/comments.service';
import {
  guardedProcedure,
  guardedProcedureAllowUnverifiedEmail,
  isFlagProtected,
  protectedProcedure,
  router,
} from '~/server/trpc';

// Votes rank the feature-request queue, so only verified-email accounts cast them (guardedProcedure).
// Comments and edits likewise, sharing the site's comment budget; reporting never needs it.
export const featurePagesRouter = router({
  vote: guardedProcedure
    .meta({ blockApiKeys: true })
    .use(isFlagProtected('featurePages'))
    .input(featurePageVoteSchema)
    .use(rateLimit({ limit: 30, period: 60 }))
    .mutation(({ ctx, input }) => castFeaturePageVote(ctx.user.id, input)),

  mine: protectedProcedure
    .meta({ blockApiKeys: true })
    .use(isFlagProtected('featurePages'))
    .input(featurePageMineSchema)
    .use(rateLimit({ limit: 30, period: 60 }))
    .query(({ ctx, input }) => getMyFeaturePageVotes(ctx.user.id, input)),

  comment: guardedProcedure
    .meta({ blockApiKeys: true })
    .use(isFlagProtected('featurePagesDiscussion'))
    .input(featurePageCommentSchema)
    .use(rateLimit(commentRateLimits, undefined, { sharedKey: COMMENT_V3_RATE_LIMIT_KEY }))
    .mutation(({ ctx, input }) => postFeaturePageComment(ctx, input)),

  edit: guardedProcedure
    .meta({ blockApiKeys: true })
    .use(isFlagProtected('featurePagesDiscussion'))
    .input(featurePageCommentEditSchema)
    .use(rateLimit(commentRateLimits, undefined, { sharedKey: COMMENT_V3_RATE_LIMIT_KEY }))
    .mutation(({ ctx, input }) => editFeaturePageComment(ctx, input)),

  retract: protectedProcedure
    .meta({ blockApiKeys: true })
    .use(isFlagProtected('featurePagesDiscussion'))
    .input(featurePageCommentRetractSchema)
    .mutation(({ ctx, input }) => retractFeaturePageComment(ctx, input)),

  report: guardedProcedureAllowUnverifiedEmail
    .meta({ blockApiKeys: true })
    .use(isFlagProtected('featurePagesDiscussion'))
    .input(featurePageCommentReportSchema)
    .use(rateLimit({ limit: 5, period: CacheTTL.day }, undefined, { onlyCountSuccess: true }))
    .mutation(({ ctx, input }) => reportFeaturePageComment(ctx, input)),
});
