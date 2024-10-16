import {
  getRecommendedResourcesCardDataHandler,
  toggleResourceRecommendationHandler,
} from '~/server/controllers/recommenders.controller';
import { applyUserPreferences, prodOnly } from '~/server/middleware.trpc';
import { getByIdSchema } from '~/server/schema/base.schema';
import { recommendationRequestSchema } from '~/server/schema/recommenders.schema';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const recommendersRouter = router({
  getResourceRecommendations: publicProcedure
    .input(recommendationRequestSchema)
    .use(prodOnly)
    .use(applyUserPreferences)
    .query(getRecommendedResourcesCardDataHandler),
  toggleResourceRecommendations: protectedProcedure
    .input(getByIdSchema)
    .use(prodOnly)
    .mutation(toggleResourceRecommendationHandler),
});
