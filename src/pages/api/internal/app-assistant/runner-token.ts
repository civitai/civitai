import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';
import { env } from '~/env/server';
import { logToAxiom, safeError } from '~/server/logging/client';
import { verifyRunGrant } from '~/server/services/app-assistant/assistant-runner-tokens';
import {
  getAppAssistantRefusalForUserId,
  mintAppAssistantToken,
} from '~/server/services/app-assistant/app-assistant.service';
import { isConfiguredSecret } from '~/server/utils/configured-secret';

/**
 * POST /api/internal/app-assistant/runner-token
 *
 * App Assistant's server runner trades a run grant for a short-lived App Assistant `chat` token
 * here, every few minutes while a reply runs, so a reply keeps going after its page closed. Called
 * only by the runner, with its own secret; body `{ grant, purpose: 'chat' }`. The token is the
 * user's, as the browser's is: the grant decides whose, not which conversation it may touch.
 *
 * Every mint runs the same gates as `/api/apps/assistant/token` (ban, onboarding, mute, email
 * verification, the App Assistant feature flag), on the user as the database has them now, and then
 * the consent check.
 *
 *   200 `{ token, expiresAt }`
 *   401 the runner's secret is missing or wrong, or the grant is not a current run grant
 *   403 `refused` when a gate refuses the user; `consent_required` once they turned App Assistant off
 *   503 not configured, the mint failed, or the gates could not be judged just now (`unavailable`)
 *
 * Like `TokenSecuredEndpoint`, a blank configured secret answers 503. Mints are logged without the
 * token.
 */
const body = z.object({
  grant: z.string().min(1).max(4096),
  purpose: z.literal('chat'),
});

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Constant-time: both sides are hashed to one length first. Both are trimmed, as the runner trims
 * its copy, so a value mounted from a file with a trailing newline still matches.
 */
function presentedSecret(req: AxiomAPIRequest, secret: string): boolean {
  const match = /^bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return !!match && timingSafeEqual(digest(match[1]!.trim()), digest(secret.trim()));
}

export default withAxiom(async (req: AxiomAPIRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = env.ASSISTANT_RUNNER_SECRET;
  if (!isConfiguredSecret(secret))
    return res.status(503).json({ error: 'Endpoint not configured' });
  if (!presentedSecret(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Expected { grant, purpose }' });
  const grant = await verifyRunGrant(parsed.data.grant);
  if (!grant)
    return res.status(401).json({ error: 'Not a current run grant', code: 'invalid_grant' });
  const { purpose } = parsed.data;

  try {
    const refusal = await getAppAssistantRefusalForUserId(grant.userId);
    // Not judged (the session hub or Flipt is down): a passing fault, which the runner retries.
    if (refusal && 'unavailable' in refusal)
      return res.status(503).json({ error: refusal.error, code: 'unavailable' });
    if (refusal) {
      logToAxiom({
        type: 'app-assistant.runner-token.refused',
        message: `App Assistant runner token refused for user ${grant.userId}`,
        userId: grant.userId,
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
