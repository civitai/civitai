import { assertAccountNotRestricted } from '~/server/services/account-restriction.service';
import { RESTRICTED_ACCOUNT_MESSAGE } from '~/server/common/content-restriction';
import { deleteApiKeys, mintApiKey } from '~/server/services/api-key.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';

const ORCHESTRATOR_KEY_NAME = 'orchestrator-key';

export default AuthedEndpoint(
  async function handler(req, res, user) {
    if (!requireFullScopeSession(req, res)) return;
    try {
      const host = req.headers.host?.toLowerCase().split(':')[0];
      if (!host) return res.status(400).json({ error: 'Missing host header' });
      const name = `${ORCHESTRATOR_KEY_NAME}:${host}`;

      await assertAccountNotRestricted(user.id);
      await deleteApiKeys({ userId: user.id, type: 'System', name });

      const key = await mintApiKey(
        { name, type: 'System', userId: user.id },
        { refusalMessage: RESTRICTED_ACCOUNT_MESSAGE }
      );

      return res.status(200).json({ key });
    } catch (e) {
      return handleEndpointError(res, e);
    }
  },
  ['GET']
);
