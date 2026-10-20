import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';
import { env } from '~/env/server';
import { logToAxiom, safeError } from '~/server/logging/client';
import { verifyRunGrant } from '~/server/services/app-assistant/assistant-runner-tokens';
import { mintAppAssistantToken } from '~/server/services/app-assistant/app-assistant.service';
import { checkRunnerMintRateLimit } from '~/server/services/app-assistant/runner-mint-rate-limit';
import { isConfiguredSecret } from '~/server/utils/configured-secret';

/**
 * POST /api/internal/app-assistant/runner-token
 *
 * App Assistant's server runner trades a run grant for a short-lived App Assistant token here, once
 * per purpose every few minutes while a reply runs, so a reply keeps going after its page closed.
 * Called only by the runner, with its own secret; body `{ grant, purpose: 'chat' | 'sandbox' }`.
 *
 *   200 `{ token, expiresAt }`
 *   401 the runner's secret is missing or wrong, or the grant is not a current run grant
 *   403 `consent_required` once the user turned App Assistant off (checked on every mint)
 *   429 the grant minted more than a run would; 503 not configured, or the mint failed
 *
 * Like `TokenSecuredEndpoint`, a blank configured secret answers 503. Mints are logged without the
 * token.
 */
const body = z.object({
  grant: z.string().min(1).max(4096),
  purpose: z.enum(['chat', 'sandbox']),
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

  const limit = await checkRunnerMintRateLimit(grant.grantId);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    return res
      .status(429)
      .json({ error: 'Too many tokens for this run grant', code: 'rate_limited' });
  }

  try {
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
