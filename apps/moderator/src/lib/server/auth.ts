import { createRevocationCheck, createSpokeGuard, type SessionRegistryRedis } from '@civitai/auth';
import { logToAxiom, safeError } from './axiom';
import { getSysRedis } from './redis';

// Same event shape as the main app's logSysRedisFailOpen, so its sysredis-fail-open alerts also see this app.
export const isRevoked = createRevocationCheck({
  redis: () => getSysRedis() as unknown as SessionRegistryRedis,
  onError: (err) => {
    logToAxiom({
      ...safeError(err),
      name: 'sysredis-fail-open',
      type: 'warning',
      subtype: 'read-degraded',
      fn: 'spoke isRevoked',
    }).catch(() => undefined);
  },
});

export const guard = createSpokeGuard({ require: (user) => user.isModerator === true, isRevoked });
