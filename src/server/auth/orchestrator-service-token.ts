import { createHash, timingSafeEqual } from 'crypto';
import type { NextApiRequest } from 'next';
import { env } from '~/env/server';
import { isConfiguredSecret } from '~/server/utils/configured-secret';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Whether the request presents the configured orchestrator service token as
 * `Authorization: Bearer <token>`. Read from the header only, compared as fixed-length digests so
 * neither the content nor the length of the configured token shapes the timing. Always false when
 * the token is unset or blank. Grants nothing on its own: callers decide what it unlocks.
 */
export function matchesOrchestratorServiceToken(req: Pick<NextApiRequest, 'headers'>): boolean {
  const configured = env.ORCHESTRATOR_SERVICE_TOKEN;
  if (!isConfiguredSecret(configured)) return false;

  const header = req.headers?.authorization;
  if (typeof header !== 'string') return false;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return false;

  // Digests, not timingSafeEqualStrings: that one returns early on a length mismatch.
  return timingSafeEqual(digest(parts[1]), digest(configured));
}
