import { getConsumerBlobUploadUrlService } from '~/server/services/orchestrator/consumerBlobUpload';
import { OrchestratorEndpoint } from '~/server/utils/endpoint-helpers';

export default OrchestratorEndpoint(
  async function handler(req, res, user, token) {
    try {
      const result = await getConsumerBlobUploadUrlService({ token });
      return res.status(200).json(result);
    } catch (e) {
      return res.status(403).send((e as Error).message);
    }
  },
  ['GET']
);
