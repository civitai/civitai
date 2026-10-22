import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as z from 'zod';
import { env } from '~/env/server';
import {
  verifyRunGrant,
  type VerifiedRunGrant,
} from '~/server/services/app-assistant/assistant-runner-tokens';
import { isConfiguredSecret } from '~/server/utils/configured-secret';

/**
 * The front door of every `/api/internal/app-assistant/*` endpoint App Assistant's server runner
 * calls, in the order each one answers:
 *   503 the runner's secret is not configured (a blank one counts as unset, as `TokenSecuredEndpoint`)
 *   401 `Unauthorized`: the bearer is missing or is not the runner's secret
 *   405 not a POST
 *   400 the body does not parse (`badBody` says what was expected)
 *   401 `invalid_grant`: the body's `grant` is not a current run grant civitai signed
 * Each refusal is written to `res`, and the function then returns null. Otherwise it returns the
 * verified grant and the parsed body. `Cache-Control: no-store` is set on every answer.
 */
export async function readRunnerRequest<S extends z.ZodType<{ grant: string }>>(
  req: NextApiRequest,
  res: NextApiResponse,
  schema: S,
  badBody: string
): Promise<{ grant: VerifiedRunGrant; body: z.infer<S> } | null> {
  res.setHeader('Cache-Control', 'no-store');
  const secret = env.ASSISTANT_RUNNER_SECRET;
  if (!isConfiguredSecret(secret)) {
    res.status(503).json({ error: 'Endpoint not configured' });
    return null;
  }
  if (!presentedSecret(req, secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return null;
  }
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: badBody });
    return null;
  }
  const grant = await verifyRunGrant(parsed.data.grant);
  if (!grant) {
    res.status(401).json({ error: 'Not a current run grant', code: 'invalid_grant' });
    return null;
  }
  return { grant, body: parsed.data };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Constant-time: both sides are hashed to one length first. Both are trimmed, as the runner trims
 * its copy, so a value mounted from a file with a trailing newline still matches.
 */
function presentedSecret(req: NextApiRequest, secret: string): boolean {
  const match = /^bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return !!match && timingSafeEqual(digest(match[1]!.trim()), digest(secret.trim()));
}
