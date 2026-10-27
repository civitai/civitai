import { createRevocationCheck, createSpokeGuard, type SessionRegistryRedis } from '@civitai/auth';
import { getSysRedis } from './redis';

export const isRevoked = createRevocationCheck({
  redis: () => getSysRedis() as unknown as SessionRegistryRedis,
});

// The door gate is any authenticated user (plan §1) — member-only capabilities are gated per-action in
// $lib/server/membership.ts, not here, so non-members can still browse the Studio.
export const guard = createSpokeGuard({ require: (user) => !!user, isRevoked });
