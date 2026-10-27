import { createSessionRegistry, type SessionRegistryRedis } from './session-registry';
import { SESSION_REGISTRY_KEYS } from './session-registry-keys';
import type { SessionClaims } from './types';

// The `isRevoked` a spoke hands to createSpokeGuard: the same registry read the hub and the main app use, so a
// sign-out, ban or force-logout written anywhere ends the session here too. Reads fail OPEN, and are bounded by a
// deadline, so a slow or unavailable store never blocks a request or signs anyone out.

export interface RevocationCheckConfig {
  /** The shared session store (`getSysRedis()`). A getter, so building the check never connects. */
  redis: () => SessionRegistryRedis;
  /** Read deadline in ms (default 2000, the main app's REDIS_SYS_READ_TIMEOUT_MS default). */
  timeoutMs?: number;
  /** Called when a read fails or times out and the check fails open. */
  onError?: (err: unknown) => void;
}

export function createRevocationCheck(
  config: RevocationCheckConfig
): (claims: SessionClaims) => Promise<boolean> {
  let registry: ReturnType<typeof createSessionRegistry> | undefined;
  const timeoutMs = config.timeoutMs ?? 2000;

  return async (claims) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      registry ??= createSessionRegistry({ redis: config.redis(), keys: SESSION_REGISTRY_KEYS });
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`revocation read timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      });
      return await Promise.race([registry.isRevoked(claims), deadline]);
    } catch (err) {
      try {
        config.onError?.(err);
      } catch {
        // observability only
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}
