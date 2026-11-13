import { createRevocationCheck, createSpokeGuard, type SessionRegistryRedis } from '@civitai/auth';
import { logToAxiom, safeError } from './axiom';
import { getSysRedis } from './redis';
import { isEnvSwitchOn } from '@civitai/shared/env-switch';

// Same event shape as the main app's logSysRedisFailOpen, so its sysredis-fail-open alerts also see this app.
// `verdict` is what the shared check answered from the markers it had already read (deny_cached|allow_unknown).
export const isRevoked = createRevocationCheck({
  redis: () => getSysRedis() as unknown as SessionRegistryRedis,
  // SESSION_REVOCATION_CACHE=off|0|false turns off the record of seen revocations (plain fail-open).
  markerCache: isEnvSwitchOn(process.env.SESSION_REVOCATION_CACHE),
  onError: (err, _reason, _claims, verdict) =>
    void logToAxiom({
      ...safeError(err),
      name: 'sysredis-fail-open',
      type: 'warning',
      subtype: 'read-degraded',
      fn: 'spoke isRevoked',
      verdict,
    }),
});

// Training is a normal user feature, so the gate allows ANY authenticated Civitai user — the predicate
// only asserts a session resolved.
export const guard = createSpokeGuard({ require: (user) => !!user, isRevoked });
