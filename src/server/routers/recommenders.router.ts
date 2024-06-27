import { getAssociatedRecommendedResourcesCardDataHandler } from '../controllers/recommenders.controller';
import { Recommenders } from '../http/recommenders/recommenders.schema';
import { applyUserPreferences } from '../middleware.trpc';
import { verifiedProcedure, router } from '~/server/trpc';

export const recommendersRouter = router({
  getResourceRecommendations: verifiedProcedure
    .input(Recommenders.RecommendationRequestSchema)
    .use(applyUserPreferences)
    .query(getAssociatedRecommendedResourcesCardDataHandler),
});
