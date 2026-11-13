import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';
import { logToAxiom, safeError } from '~/server/logging/client';
import {
  getAppAssistantRefusalForUserId,
  mintAppAssistantToken,
} from '~/server/services/app-assistant/app-assistant.service';
import { readRunnerRequest } from '~/server/services/app-assistant/runner-request';

/**
 * POST /api/internal/app-assistant/runner-token
 *
 * App Assistant's server runner trades a run grant for a short-lived App Assistant token here,
 * every few minutes while a reply runs, so a reply keeps going after its page closed. Called only by
 * the runner, with its own secret; body `{ grant, purpose }`, `purpose` `chat` (the model and the
 * conversation store) or `sandbox` (the hosted sandbox service and its tools), as the browser's token
 * route mints them. The token is the user's, as the browser's is: the grant decides whose, not which
 * conversation it may touch.
 *
 * Every mint, of either purpose, runs the same gates as `/api/apps/assistant/token` (ban,
 * onboarding, mute, email verification, the App Assistant feature flag) plus the server runner's own
 * flag (`appAssistantRemoteRunner`), on the user as the database has them now, and then the consent
 * check.
 *
 *   200 `{ token, expiresAt }`
 *   401 the runner's secret is missing or wrong, or the grant is not a current run grant
 *   403 `refused` when a gate refuses the user; `consent_required` once they turned App Assistant off
 *       `refused` also for a `chat` token asked with a preview grant (`use: 'preview'`), which mints
 *       `sandbox` tokens only
 *   503 not configured, the mint failed, or the gates could not be judged just now (`unavailable`)
 *
 * Like `TokenSecuredEndpoint`, a blank configured secret answers 503. Mints are logged without the
 * token. The secret, method, body and grant checks are `readRunnerRequest`'s, shared with the
 * runner's dev-tunnel endpoints.
 */
const body = z.object({
  grant: z.string().min(1).max(4096),
  purpose: z.enum(['chat', 'sandbox']),
});

export default withAxiom(async (req: AxiomAPIRequest, res: NextApiResponse) => {
  const request = await readRunnerRequest(req, res, body, 'Expected { grant, purpose }');
  if (!request) return;
  const { grant } = request;
  const { purpose } = request.body;
  // A preview grant opens one live preview: the sandbox's token, never one that spends Buzz.
  if (grant.use === 'preview' && purpose !== 'sandbox')
    return res
      .status(403)
      .json({ error: 'A preview grant mints sandbox tokens only', code: 'refused' });

  try {
    // The runner's own flag too: turning it off ends runs already holding a grant at their next mint.
    const refusal = await getAppAssistantRefusalForUserId(grant.userId, { remoteRunner: true });
    // Not judged (the session hub or Flipt is down): a passing fault, which the runner retries.
    if (refusal && 'unavailable' in refusal)
      return res.status(503).json({ error: refusal.error, code: 'unavailable' });
    if (refusal) {
      logToAxiom({
        type: 'app-assistant.runner-token.refused',
        message: `App Assistant runner token refused for user ${grant.userId}`,
        userId: grant.userId,
        purpose,
        grantId: grant.grantId,
        reason: refusal.error,
      }).catch(() => undefined);
      return res.status(refusal.status).json({ error: refusal.error, code: 'refused' });
    }
    const minted = await mintAppAssistantToken(grant.userId, purpose);
    if (!minted)
      return res
        .status(403)
        .json({ error: 'Turn on App Assistant to continue', code: 'consent_required' });
    logToAxiom({
      type: 'app-assistant.runner-token.minted',
      message: `App Assistant runner token minted for user ${grant.userId}`,
      userId: grant.userId,
      purpose,
      grantId: grant.grantId,
    }).catch(() => undefined);
    return res.json(minted);
  } catch (err) {
    logToAxiom({
      type: 'app-assistant.runner-token.failed',
      message: `App Assistant runner token mint failed for user ${grant.userId}`,
      purpose,
      grantId: grant.grantId,
      error: safeError(err),
    }).catch(() => undefined);
    return res.status(503).json({ error: 'Could not mint a token right now' });
  }
});
