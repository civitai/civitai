import { imageUpload } from '~/server/services/orchestrator/imageUpload';
import { OrchestratorEndpoint } from '~/server/utils/endpoint-helpers';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '16mb', // Set desired value here
    },
  },
};

export default OrchestratorEndpoint(
  async function handler(req, res, user, token) {
    const sourceImage = req.body;
    const result = await imageUpload({ token, sourceImage });
    return res.status(200).send(result.blob);
  },
  ['POST']
);
