import { createRevocationCheck, createSpokeGuard, type SessionRegistryRedis } from '@civitai/auth';
import { getSysRedis } from './redis';

export const isRevoked = createRevocationCheck({
  redis: () => getSysRedis() as unknown as SessionRegistryRedis,
});

export const guard = createSpokeGuard({ require: (user) => user.isModerator === true, isRevoked });
