import {
  SESSION_REGISTRY_KEYS,
  createSessionRegistry,
  type SessionRegistry,
  type SessionRegistryRedis,
} from '@civitai/auth';
import { REDIS_KEYS } from '@civitai/redis';
import { getRedis, getSysRedis } from './redis';

// Cross-app session revocation, mirroring apps/auth's registry: same redis, same key strings, so a mute
// or force-logout here is seen by every app immediately.
//
// Revoking tokens is only half of it. `session:data2:{userId}` caches the resolved SessionUser — INCLUDING
// `muted` — for 4h, and the hub's login path (`getOrProduceSessionUser`) is cache-first. Without the
// `onInvalidate` bust below, a muted user is kicked out, logs straight back in, and is handed the stale
// pre-mute session: the mute does nothing for up to four hours. The main app's own mute path busts this
// cache (`clearSessionCache`); this one has to as well.
//
// Built lazily on first use so `vite build` never touches REDIS_* or connects.
let registry: SessionRegistry | undefined;

function get(): SessionRegistry {
  if (registry) return registry;
  return (registry = createSessionRegistry({
    // sysRedis's methods are typed to the known-key union; the registry is namespace-agnostic, so cast
    // at this boundary — apps/auth and the main app do the same.
    redis: getSysRedis() as unknown as SessionRegistryRedis,
    keys: SESSION_REGISTRY_KEYS,
    onInvalidate: async ({ scope, userId }) => {
      if (scope === 'all' || userId == null) return;
      await getRedis().del(`${REDIS_KEYS.USER.SESSION}:${userId}`);
    },
  }));
}

/** Revoke every active session for a user AND drop their cached session — used by mute, ban and
 *  force-logout. Revocation alone leaves the mute invisible until the cache expires. */
export async function invalidateUserSessions(userId: number): Promise<void> {
  await get().invalidateUserSessions(userId);
}
