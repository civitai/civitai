import { dbWrite } from '~/server/db/client';
import { addApiKey } from '~/server/services/api-key.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';

const ORCHESTRATOR_KEY_NAME = 'orchestrator-key';

export default AuthedEndpoint(
  async function handler(req, res, user) {
    try {
      const host = req.headers.host?.toLowerCase().split(':')[0];
      if (!host) return res.status(400).json({ error: 'Missing host header' });
      const name = `${ORCHESTRATOR_KEY_NAME}:${host}`;

      await dbWrite.apiKey.deleteMany({
        where: { userId: user.id, type: 'System', name },
      });

      const key = await addApiKey({
        name,
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
