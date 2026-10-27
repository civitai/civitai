import { createRevocationCheck, createSpokeGuard, type SessionRegistryRedis } from '@civitai/auth';
import { getSysRedis } from './redis';

export const isRevoked = createRevocationCheck({
  redis: () => getSysRedis() as unknown as SessionRegistryRedis,
});

// Training is a normal user feature, so the gate allows ANY authenticated Civitai user — the predicate
// only asserts a session resolved.
export const guard = createSpokeGuard({ require: (user) => !!user, isRevoked });
