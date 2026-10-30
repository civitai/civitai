import { createRevocationCheck, createSpokeGuard, type SessionRegistryRedis } from '@civitai/auth';
import { logToAxiom, safeError } from './axiom';
import { getSysRedis } from './redis';

// Same event shape as the main app's logSysRedisFailOpen, so its sysredis-fail-open alerts also see this app.
export const isRevoked = createRevocationCheck({
  redis: () => getSysRedis() as unknown as SessionRegistryRedis,
  onError: (err) =>
    void logToAxiom({
      ...safeError(err),
      name: 'sysredis-fail-open',
      type: 'warning',
      subtype: 'read-degraded',
      fn: 'spoke isRevoked',
    }),
});

// Training is a normal user feature, so the gate allows ANY authenticated Civitai user — the predicate
// only asserts a session resolved.
export const guard = createSpokeGuard({ require: (user) => !!user, isRevoked });
