import {
  isAssistantRunnerConfigured,
  signRunnerViewerToken,
} from '~/server/services/app-assistant/assistant-runner-tokens';
import { getAppAssistantRefusal } from '~/server/services/app-assistant/app-assistant.service';
import { logToAxiom, safeError } from '~/server/logging/client';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';

/**
 * The page's sign-in for App Assistant's server runner: a five-minute viewer token naming the user,
 * sent as `Authorization: Bearer` on every run-API request (start, follow, stop). The runner never
 * reads the civitai session cookie. Needs a full-scope session, as the token route does.
 *
 *   GET → `{ token, expiresAt }`
 */
export default AuthedEndpoint(async (req, res, user) => {
  if (!requireFullScopeSession(req, res)) return;
  const refusal = await getAppAssistantRefusal({ user, req });
  if (refusal) return res.status(refusal.status).json({ error: refusal.error });
  res.setHeader('Cache-Control', 'no-store');
  if (!isAssistantRunnerConfigured())
    return res.status(503).json({ error: 'The App Assistant runner is not available' });
  try {
    return res.json(await signRunnerViewerToken(user.id));
  } catch (err) {
    logToAxiom({
      type: 'app-assistant.runner-viewer-token.failed',
      message: `App Assistant runner viewer token failed for user ${user.id}`,
      error: safeError(err),
    }).catch(() => undefined);
    return res.status(503).json({ error: 'The App Assistant runner is not available' });
  }
});
