import {
  SESSION_REGISTRY_KEYS,
  createSessionRegistry,
  type SessionRegistry,
  type SessionRegistryRedis,
} from '@civitai/auth';
import { REDIS_KEYS } from '@civitai/redis';
import { env } from '$env/dynamic/private';
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

// Revoking a token makes the NEXT request fail; it does not reach a client that is already connected.
// The main app pairs every invalidation with this signal (`invalidateSession`), and without it a muted
// user keeps their open tab — able to read, and to see their own posts succeed — until something makes
// them refresh. Always 'invalid' rather than 'refresh': the tokens are already revoked, so telling a
// client to refresh would only send it at a dead token.
//
// Best-effort on purpose, matching the main app: a signals outage must not fail the mute that has
// already been written. SIGNALS_ENDPOINT is unset in local dev, which no-ops this entirely.
async function sendSessionSignal(userId: number): Promise<void> {
  const endpoint = env.SIGNALS_ENDPOINT;
  if (!endpoint) return;
  try {
    await fetch(`${endpoint}/users/${userId}/signals/session:refresh`, {
      method: 'POST',
      body: JSON.stringify({ type: 'invalid' }),
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // swallowed — see above
  }
}

/** Revoke every active session for a user, drop their cached session, and push connected clients out —
 *  used by mute, unmute, ban and force-logout. Revocation alone leaves the mute invisible until the
 *  cache expires; without the signal it does not reach an already-open tab at all. */
export async function invalidateUserSessions(userId: number): Promise<void> {
  await get().invalidateUserSessions(userId);
  await sendSessionSignal(userId);
}
