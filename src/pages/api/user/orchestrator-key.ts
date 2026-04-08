import { dbWrite } from '~/server/db/client';
import { addApiKey } from '~/server/services/api-key.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';

const ORCHESTRATOR_KEY_NAME = 'orchestrator-key';

export default AuthedEndpoint(
  async function handler(req, res, user) {
    try {
      await dbWrite.apiKey.deleteMany({
        where: { userId: user.id, type: 'System', name: ORCHESTRATOR_KEY_NAME },
      });

      const key = await addApiKey({
        name: ORCHESTRATOR_KEY_NAME,
        scope: ['Generate'],
        type: 'System',
        userId: user.id,
      });

      return res.status(200).json({ key });
    } catch (e) {
      return handleEndpointError(res, e);
    }
  },
  ['GET']
);
