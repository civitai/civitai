import { REDIS_SYS_KEYS } from '@civitai/redis';
import { getSysRedis } from '../redis';

// Single-use enforcement for cross-domain SWAP tokens. A swap token is short-lived (AUTH_SWAP_MAX_AGE, ~60s)
// and signature-bound, but it travels through a browser URL on the way to the spoke — so we also burn its `jti`
// the first time it's redeemed, making a captured token unusable a second time.
const SWAP_TTL_S = 60; // upper bound on a swap token's lifetime; the marker only needs to outlive the token
const usedKey = (jti: string) => `${REDIS_SYS_KEYS.SWAP.USED}:${jti}` as const;

/**
 * Atomically mark a swap-token `jti` as redeemed. Returns true if this is the FIRST redemption (allow), false
 * on replay. When sysRedis is unconfigured (dev) single-use can't be enforced, so it allows; a redis blip also
 * fails open (allow) to match the codebase's redis philosophy — the token's 60s TTL + signature still bound it.
 */
export async function consumeSwapToken(jti: string): Promise<boolean> {
  const sys = getSysRedis();
  if (!sys) return true;
  try {
    const fresh = await sys.setNX(usedKey(jti), '1'); // true if newly set, false if already redeemed
    if (!fresh) return false;
    await sys.expire(usedKey(jti), SWAP_TTL_S).catch(() => {}); // best-effort TTL (a lingering marker is safe)
    return true;
  } catch {
    return true; // fail open (redis blip) — the short TTL + signature are the primary defense
  }
}
