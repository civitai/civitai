import { env } from '~/env/client';
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
    const host = req.headers.host;
    const allowMatureContent = host === env.NEXT_PUBLIC_SERVER_DOMAIN_BLUE;

    try {
      const result = await imageUpload({ token, sourceImage, allowMatureContent });
      return res.status(200).send(result.blob);
    } catch (e) {
      return res.status(403).send((e as Error).message);
    }
  },
  ['POST']
);
