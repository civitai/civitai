import { rateLimit } from '~/server/middleware.trpc';
import { featurePageMineSchema, featurePageVoteSchema } from '~/server/schema/feature-pages.schema';
import {
  castFeaturePageVote,
  getMyFeaturePageVotes,
} from '~/server/services/feature-pages.service';
import { guardedProcedure, isFlagProtected, protectedProcedure, router } from '~/server/trpc';

// Votes rank the feature-request queue, so only verified-email accounts cast them (guardedProcedure).
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
});
