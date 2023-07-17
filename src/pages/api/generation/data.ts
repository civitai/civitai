import {
  createGenerationRequestSchema,
  getGenerationDataSchema,
  getGenerationRequestsSchema,
} from '~/server/schema/generation.schema';
import {
  createGenerationRequest,
  getGenerationData,
  getGenerationRequests,
} from '~/server/services/generation/generation.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

export default PublicEndpoint(
  async function handler(req, res) {
    try {
      const queryInput = getGenerationDataSchema.parse(req.query);
      const queryResult = await getGenerationData({ ...queryInput });
      return res.status(200).json(queryResult);
    } catch (e: any) {
      res.status(400).send({ message: e.message });
    }
  },
  ['GET']
);
