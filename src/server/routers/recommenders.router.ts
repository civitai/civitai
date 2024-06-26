import { Recommenders } from '../http/recommenders/recommenders.schema';
import { applyUserPreferences } from '../middleware.trpc';
import { userPreferencesSchema } from '../schema/base.schema';
import { getAllModelsSchema } from '../schema/model.schema';
import { getModelsRaw } from '../services/model.service';
import { getRecommendations } from '../services/recommenders.service';
import { verifiedProcedure, router } from '~/server/trpc';


export const recommendersRouter = router({
  getResourceRecommendations: verifiedProcedure.input(Recommenders.RecommendationRequestSchema).use(applyUserPreferences)
  .query(async (params)=> {
    const recommendations_modelVersionIds:Promise<number[]|undefined> = getRecommendations(params.input);
    return recommendations_modelVersionIds
  })
})

