import {
  createSessionRegistry,
  type SessionRegistry,
  type SessionRegistryRedis,
} from '@civitai/auth';
import { REDIS_KEYS, REDIS_SYS_KEYS } from '@civitai/redis';
import { getSysRedis } from './redis';

// Cross-app session revocation, mirroring apps/auth's registry: same redis, same key strings from
// @civitai/redis, so a mute or force-logout here is seen by every app immediately.
//
// This is what makes muting from the moderator app real. Setting `User.muted` alone leaves the muted
// account posting until its session happens to refresh — a silent failure a moderator would blame on
// the tool.
//
// Built lazily on first use so `vite build` never touches REDIS_* or connects.
let registry: SessionRegistry | undefined;

function get(): SessionRegistry {
  if (registry) return registry;
  return (registry = createSessionRegistry({
    // sysRedis's methods are typed to the known-key union; the registry is namespace-agnostic, so cast
    // at this boundary — apps/auth and the main app do the same.
    redis: getSysRedis() as unknown as SessionRegistryRedis,
    keys: {
      tokenState: REDIS_SYS_KEYS.SESSION.TOKEN_STATE,
      all: REDIS_SYS_KEYS.SESSION.ALL,
      userTokens: REDIS_KEYS.SESSION.USER_TOKENS,
    },
  }));
}

/** Revoke every active session for a user — used by mute, ban and force-logout. */
export async function invalidateUserSessions(userId: number): Promise<void> {
  await get().invalidateUserSessions(userId);
}
