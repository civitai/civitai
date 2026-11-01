import type { AppAssistantTokenPurpose } from '~/server/services/app-assistant/app-assistant.service';
import {
  enableAppAssistant,
  getAppAssistantRefusal,
  mintAppAssistantToken,
} from '~/server/services/app-assistant/app-assistant.service';
import { logToAxiom, safeError } from '~/server/logging/client';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';

/**
 * App Assistant's OAuth access tokens. Minting needs a full-scope session, because the chat token
 * spends Buzz.
 *
 *   GET  ?for=chat|sandbox → `{ token, expiresAt }`, or 403 `consent_required` until it is turned on
 *   POST (JSON)            → turns App Assistant on (the user's click), then as GET for the chat
 *
 * Only POST writes consent, so a GET from a token refresh cannot re-grant what the user revoked.
 * POST must be JSON so a cross-origin form cannot send it without a CORS preflight.
 */
export default AuthedEndpoint(
  async (req, res, user) => {
    if (!requireFullScopeSession(req, res)) return;
    const refusal = await getAppAssistantRefusal({ user, req });
    if (refusal) return res.status(refusal.status).json({ error: refusal.error });
    if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json'))
      return res.status(415).json({ error: 'Expected a JSON request' });

    const purpose: AppAssistantTokenPurpose =
      req.method === 'GET' && req.query.for === 'sandbox' ? 'sandbox' : 'chat';
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method === 'POST') await enableAppAssistant(user.id);
      const minted = await mintAppAssistantToken(user.id, purpose);
      if (!minted)
        return res
          .status(403)
          .json({ error: 'Turn on App Assistant to continue', code: 'consent_required' });
      return res.json(minted);
    } catch (err) {
      logToAxiom({
        type: 'app-assistant.token.failed',
        message: `App Assistant token mint failed for user ${user.id}`,
        error: safeError(err),
      }).catch(() => undefined);
      return res.status(503).json({ error: 'Could not start an App Assistant session right now' });
    }
  },
  ['GET', 'POST']
);
