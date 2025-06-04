import { env } from '~/env/server';
import { HttpCaller } from '~/server/http/httpCaller';
import type {
  RecommendationRequest,
  RecommendationsResponse,
} from '~/server/schema/recommenders.schema';
import { recommendationsResponseSchema } from '~/server/schema/recommenders.schema';

// DOCUMENTATION
// https://github.com/civitai/rec-r2r

class RecommenderCaller extends HttpCaller {
  private static instance: RecommenderCaller;

  protected constructor(baseUrl: string, options?: { headers?: MixedObject }) {
    super(baseUrl, options);
  }

  static getInstance(): RecommenderCaller {
    if (!env.RESOURCE_RECOMMENDER_URL) throw new Error('Missing RESOURCE_RECOMMENDER_URL env');
    if (!RecommenderCaller.instance) {
      RecommenderCaller.instance = new RecommenderCaller(env.RESOURCE_RECOMMENDER_URL);
    }

    return RecommenderCaller.instance;
  }

  async getRecommendationsForResource(payload: RecommendationRequest) {
    const response = await this.post<RecommendationsResponse>(`/recommendations`, { payload });
    if (!response.ok) throw new Error('Failed to get recommendations');

    const result = recommendationsResponseSchema.safeParse(response.data);
    if (!result.success) throw new Error('Failed to parse recommendation response');

    return result.data;
  }
}

export default RecommenderCaller.getInstance;
