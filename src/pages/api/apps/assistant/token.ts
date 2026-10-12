import {
  getAppAssistantRefusal,
  mintAppAssistantToken,
} from '~/server/services/app-assistant/app-assistant.service';
import { logToAxiom, safeError } from '~/server/logging/client';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';

/**
 * GET → `{ token, expiresAt }`: an OAuth access token for the caller's App Assistant, used by
 * `<civitai-chat>` and the hosted sandbox service. It can spend Buzz, so only a full-scope
 * session may mint one.
 */
export default AuthedEndpoint(async (req, res, user) => {
  if (!requireFullScopeSession(req, res)) return;
  const refusal = await getAppAssistantRefusal({ user, req });
  if (refusal) return res.status(refusal.status).json({ error: refusal.error });

  res.setHeader('Cache-Control', 'no-store');
  try {
    return res.json(await mintAppAssistantToken(user.id));
  } catch (err) {
    logToAxiom({
      type: 'app-assistant.token.failed',
      message: `App Assistant token mint failed for user ${user.id}`,
      error: safeError(err),
    }).catch(() => undefined);
    return res.status(503).json({ error: 'Could not start an App Assistant session right now' });
  }
});
