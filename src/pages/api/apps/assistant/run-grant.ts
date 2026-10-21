import * as z from 'zod';
import {
  isAssistantRunnerConfigured,
  signRunGrant,
} from '~/server/services/app-assistant/assistant-runner-tokens';
import {
  getAppAssistantRefusal,
  hasAppAssistantConsent,
} from '~/server/services/app-assistant/app-assistant.service';
import { logToAxiom, safeError } from '~/server/logging/client';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';

const query = z.object({
  conversationId: z.string().min(1).max(200),
  idempotencyKey: z.string().min(1).max(200),
});

/**
 * A run grant for App Assistant's server runner: the page asks for one as it starts a reply there,
 * and sends it with the start (`X-Run-Grant`), so the reply keeps going after the page closes. While
 * it is live (`ASSISTANT_RUNNER_GRANT_TTL_SECONDS`), the runner can trade it for App Assistant tokens
 * for the user: those tokens are user-wide, as the browser's are. The conversation and idempotency
 * key it names are checked by the runner when it starts the run (the conversation also when it
 * writes a patch), not by the mint. Needs a full-scope session, as the token route does, the App
 * Assistant gates, and the user's App Assistant consent.
 *
 *   GET ?conversationId=&idempotencyKey= → `{ grant, expiresAt }`, or 403 `consent_required`
 */
export default AuthedEndpoint(async (req, res, user) => {
  if (!requireFullScopeSession(req, res)) return;
  const refusal = await getAppAssistantRefusal({ user, req });
  if (refusal) return res.status(refusal.status).json({ error: refusal.error });
  const parsed = query.safeParse(req.query);
  if (!parsed.success)
    return res.status(400).json({ error: 'conversationId and idempotencyKey are required' });
  res.setHeader('Cache-Control', 'no-store');
  if (!isAssistantRunnerConfigured())
    return res.status(503).json({ error: 'The App Assistant runner is not available' });
  try {
    if (!(await hasAppAssistantConsent(user.id)))
      return res
        .status(403)
        .json({ error: 'Turn on App Assistant to continue', code: 'consent_required' });
    const { token, expiresAt } = await signRunGrant({ userId: user.id, ...parsed.data });
    return res.json({ grant: token, expiresAt });
  } catch (err) {
    logToAxiom({
      type: 'app-assistant.run-grant.failed',
      message: `App Assistant run grant failed for user ${user.id}`,
      error: safeError(err),
    }).catch(() => undefined);
    return res.status(503).json({ error: 'Could not start an App Assistant reply right now' });
  }
});
