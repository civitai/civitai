import {
  getAssociatedRecommendedResourcesCardDataHandler,
  toggleResourceRecommendationHandler,
} from '~/server/controllers/recommenders.controller';
import { applyUserPreferences } from '~/server/middleware.trpc';
import { getByIdSchema } from '~/server/schema/base.schema';
import { recommendationRequestSchema } from '~/server/schema/recommenders.schema';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const recommendersRouter = router({
  getResourceRecommendations: publicProcedure
    .input(recommendationRequestSchema)
    .use(applyUserPreferences)
    .query(getAssociatedRecommendedResourcesCardDataHandler),
  toggleResourceRecommendations: protectedProcedure
    .input(getByIdSchema)
    .mutation(toggleResourceRecommendationHandler),
});
