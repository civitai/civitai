import {
  getRecommendedResourcesCardDataHandler,
  toggleResourceRecommendationHandler,
} from '~/server/controllers/recommenders.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import { recommendationRequestSchema } from '~/server/schema/recommenders.schema';
import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const recommendersRouter = router({
  getResourceRecommendations: publicProcedure
    .input(recommendationRequestSchema)
    .use(isFlagProtected('recommenders'))
    .query(getRecommendedResourcesCardDataHandler),
  toggleResourceRecommendations: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('recommenders'))
    .mutation(toggleResourceRecommendationHandler),
});
