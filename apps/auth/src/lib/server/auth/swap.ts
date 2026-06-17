import { loadAuthEnv } from '@civitai/auth';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { getSysRedis } from '../redis';

// Single-use enforcement for cross-domain SWAP tokens. A swap token is short-lived + signature-bound, but it
// travels through a browser URL on the way to the spoke (logs / history / Referer), so we burn its `jti` the
// first time it's redeemed, making a captured token unusable a second time.
const usedKey = (jti: string) => `${REDIS_SYS_KEYS.SWAP.USED}:${jti}` as const;
// The marker must OUTLIVE the token, so derive it from the same AUTH_SWAP_MAX_AGE the signer uses (+ buffer) —
// otherwise raising the token TTL would let the marker expire first and reopen a replay window.
const markerTtl = (): number => (loadAuthEnv().AUTH_SWAP_MAX_AGE ?? 60) + 5;

/**
 * Atomically mark a swap-token `jti` as redeemed. Returns true if this is the FIRST redemption (allow), false on
 * replay. Fails CLOSED (deny) whenever single-use can't be enforced — sysRedis unconfigured OR a redis error.
 * A failed exchange is recoverable (re-login); a replay into a full session is not. (Previously this returned
 * true with sysRedis absent, which SILENTLY DISABLED single-use → full replay. Security finding B4.)
 */
export async function consumeSwapToken(jti: string): Promise<boolean> {
  const sys = getSysRedis();
  if (!sys) return false; // fail CLOSED: no single-use store → no replay protection → deny
  try {
    const fresh = await sys.setNX(usedKey(jti), '1'); // true if newly set, false if already redeemed
    if (!fresh) return false;
    await sys.expire(usedKey(jti), markerTtl()).catch(() => {}); // best-effort TTL (a lingering marker is safe)
    return true;
  } catch {
    return false; // fail CLOSED on a redis error — better to reject a valid exchange than allow a replay
  }
}
