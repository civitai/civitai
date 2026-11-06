import { createRevocationCheck, createSpokeGuard, type SessionRegistryRedis } from '@civitai/auth';
import { safeError } from '@civitai/axiom';
import { getLogger } from './logger';
import { getSysRedis } from './redis';

// Same event shape as the main app's logSysRedisFailOpen, so its sysredis-fail-open alerts also see this app.
export const isRevoked = createRevocationCheck({
  redis: () => getSysRedis() as unknown as SessionRegistryRedis,
  onError: (err) => {
    getLogger()
      .logToAxiom({
        app: 'creator-studio',
        ...safeError(err),
        name: 'sysredis-fail-open',
        type: 'warning',
        subtype: 'read-degraded',
        fn: 'spoke isRevoked',
      })
      .catch(() => undefined);
  },
});

// The door gate is any authenticated user (plan §1) — member-only capabilities are gated per-action in
// $lib/server/membership.ts, not here, so non-members can still browse the Studio.
export const guard = createSpokeGuard({ require: (user) => !!user, isRevoked });
