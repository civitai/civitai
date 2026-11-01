import * as z from 'zod';
import {
  isAssistantRunnerConfigured,
  signRunGrant,
} from '~/server/services/app-assistant/assistant-runner-tokens';
import {
  getAppAssistantRefusal,
  hasAppAssistantConsent,
} from '~/server/services/app-assistant/app-assistant.service';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import { logToAxiom, safeError } from '~/server/logging/client';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';

const query = z.object({
  conversationId: z.string().min(1).max(200),
  idempotencyKey: z.string().min(1).max(200),
  purpose: z.literal('preview').optional(),
});

/**
 * A run grant for App Assistant's server runner: the page asks for one as it starts a reply there,
 * and sends it with the start (`X-Run-Grant`), so the reply keeps going after the page closes. While
 * it is live (`ASSISTANT_RUNNER_GRANT_TTL_SECONDS`), the runner can trade it for App Assistant tokens
 * for the user: those tokens are user-wide, as the browser's are. The conversation and idempotency
 * key it names are checked by the runner when it starts the run (the conversation also when it
 * writes a patch), not by the mint. Needs a full-scope session, as the token route does, the App
 * Assistant gates, the user's App Assistant consent, and `appAssistantRemoteRunner` on for them: the
 * runner is rolled out by that flag, so without it no reply starts there (403 `runner_off`). The grant
 * says whether the viewer may start subagents (`appAssistantSubagents`), so the runner takes that from
 * civitai rather than from the page.
 *
 * With `purpose=preview` it signs a preview grant instead (7 minutes, `PREVIEW_GRANT_TTL_SECONDS`, no subagents), which the
 * runner takes only for the page's Restart preview (`POST /api/assistant-runner/apps/<app>/preview`);
 * the page names `conversationId=preview:<app>`, which the runner checks against the app.
 *
 *   GET ?conversationId=&idempotencyKey=[&purpose=preview] → `{ grant, expiresAt }`, or 403
 *   `consent_required` / `runner_off`
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
    const features = await getFeatureFlagsAsync({ user, req });
    if (!features.appAssistantRemoteRunner)
      return res.status(403).json({
        error: 'Replies on the server are not available on this account',
        code: 'runner_off',
      });
    if (!(await hasAppAssistantConsent(user.id)))
      return res
        .status(403)
        .json({ error: 'Turn on App Assistant to continue', code: 'consent_required' });
    const { purpose, ...fields } = parsed.data;
    const { token, expiresAt } = await signRunGrant({
      userId: user.id,
      ...fields,
      ...(purpose === 'preview'
        ? { use: 'preview' as const }
        : { subagents: !!features.appAssistantSubagents }),
    });
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
