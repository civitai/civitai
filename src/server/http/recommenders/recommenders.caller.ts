import { env } from '~/env/server.mjs';
import { HttpCaller } from '~/server/http/httpCaller';
import { parseStringPromise, Builder } from 'xml2js';
import {
  RecommendationRequest,
  recommendationResponseSchema,
} from '~/server/schema/recommenders.schema';

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

  async getResourceRecommendationForResource(params: RecommendationRequest) {
    const response = await this.getRaw(`/recommendations/${params.modelVersionId}`);
    const json = await response.json();
    return recommendationResponseSchema.parse(json);
  }
}

export default RecommenderCaller.getInstance();
