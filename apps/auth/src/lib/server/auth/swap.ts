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
 * replay. With sysRedis unconfigured (dev) single-use can't be enforced, so it allows. A redis ERROR fails
 * CLOSED (deny): a failed exchange is recoverable (re-login), a replay into a full session is not.
 */
export async function consumeSwapToken(jti: string): Promise<boolean> {
  const sys = getSysRedis();
  if (!sys) return true;
  try {
    const fresh = await sys.setNX(usedKey(jti), '1'); // true if newly set, false if already redeemed
    if (!fresh) return false;
    await sys.expire(usedKey(jti), markerTtl()).catch(() => {}); // best-effort TTL (a lingering marker is safe)
    return true;
  } catch {
    return false; // fail CLOSED on a redis error — better to reject a valid exchange than allow a replay
  }
}
