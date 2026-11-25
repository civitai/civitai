import { createRevocationCheck, createSpokeGuard, type SessionRegistryRedis } from '@civitai/auth';
import { metrics } from './metrics';
import { getSysRedis } from './redis';

export const isRevoked = createRevocationCheck({
  redis: () => getSysRedis() as unknown as SessionRegistryRedis,
  // Only the error's name: a Redis error message can carry key names.
  onError: (err, reason, _claims, verdict) =>
    console.warn('[knights] sysredis-fail-open', {
      reason,
      verdict,
      error: err instanceof Error ? err.name : typeof err,
    }),
  onOutcome: (outcome) => metrics.revocationCheck(outcome),
});

export const guard = createSpokeGuard({
  require: (user) => !!user,
  isRevoked,
  onSessionSlot: metrics.sessionCookieSlot,
});
