import { createRevocationCheck, createSpokeGuard, type SessionRegistryRedis } from '@civitai/auth';
import { getSysRedis } from './redis';

export const isRevoked = createRevocationCheck({
  redis: () => getSysRedis() as unknown as SessionRegistryRedis,
  onError: (err) => console.warn('[knights] sysredis-fail-open', err),
});

export const guard = createSpokeGuard({ require: (user) => !!user, isRevoked });
