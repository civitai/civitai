import { createHash, timingSafeEqual } from 'crypto';
import type { NextApiRequest } from 'next';
import { env } from '~/env/server';
import { isConfiguredSecret } from '~/server/utils/configured-secret';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Whether `value` is the configured orchestrator service token. Always false when the token is
 * unset or blank. Compared as fixed-length digests, so how the value relates to the configured
 * token, including its length, does not shape the timing.
 */
export function isOrchestratorServiceToken(value: string): boolean {
  const configured = env.ORCHESTRATOR_SERVICE_TOKEN;
  if (!isConfiguredSecret(configured)) return false;
  // Digests, not timingSafeEqualStrings: that one returns early on a length mismatch.
  return timingSafeEqual(digest(value), digest(configured));
}

/**
 * Whether the request presents the service token as `Authorization: Bearer <token>`, read from the
 * header only. Grants nothing on its own: callers decide what it unlocks.
 */
export function matchesOrchestratorServiceToken(req: Pick<NextApiRequest, 'headers'>): boolean {
  const header = req.headers?.authorization;
  if (typeof header !== 'string') return false;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return false;

  return isOrchestratorServiceToken(parts[1]);
}
