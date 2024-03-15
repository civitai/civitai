import {
  createGenerationRequestSchema,
  getGenerationRequestsSchema,
} from '~/server/schema/generation.schema';
import {
  createGenerationRequest,
  getGenerationRequests,
} from '~/server/services/generation/generation.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

export default AuthedEndpoint(
  async function handler(req, res, user) {
    try {
      switch (req.method) {
        case 'POST':
          const createInput = createGenerationRequestSchema.parse(req.body);
          const createResult = await createGenerationRequest({
            ...createInput,
            userId: user.id,
            userTier: user.tier,
            isModerator: user.isModerator,
          });
          return res.status(200).json(createResult);
        case 'GET':
          const queryInput = getGenerationRequestsSchema.parse(req.query);
          const queryResult = await getGenerationRequests({ ...queryInput, userId: user.id });
          return res.status(200).json(queryResult);
      }
    } catch (e: any) {
      res.status(400).send({ message: e.message });
    }
  },
  ['GET', 'POST']
);
