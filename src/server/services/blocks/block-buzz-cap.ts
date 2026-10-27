import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { RedisKeyTemplateSys } from '~/server/redis/client';

// 25h TTL: comfortably covers a UTC-day window plus clock skew; the key is
// re-derived per day so a stale counter never bleeds into the next window.
export const BLOCK_BUZZ_CAP_TTL_SECONDS = 25 * 60 * 60;

export function buzzCapWindowKey(): string {
  // UTC calendar day, e.g. '2026-06-02'.
  return new Date().toISOString().slice(0, 10);
}

export function buzzCapRedisKey(
  userId: number
): `${typeof REDIS_SYS_KEYS.BLOCKS.BUZZ_CAP}:${string}` {
  // PER-USER aggregate: appBlockId is intentionally NOT part of the key so all
  // of a user's installed blocks share ONE daily ceiling.
  return `${REDIS_SYS_KEYS.BLOCKS.BUZZ_CAP}:${userId}:${buzzCapWindowKey()}`;
}

/**
 * THE ONE reserve primitive behind every cumulative Buzz counter in this router
 * (per-user daily, run-for-real session, consent budget). Atomic INCRBY, then arm
 * the window's TTL on the (effectively) first write, with a `ttl < 0` re-arm for a
 * key that somehow lost it.
 *
 * 🔴 IT SELF-UNWINDS ITS OWN INCRBY, AND THAT IS THE REASON IT IS ONE FUNCTION.
 * Everything after the INCRBY is a SEPARATE Redis round-trip that can throw on its
 * own, and by then `cost` is already ON the counter. The caller cannot clean that up
 * — it never learns the key, because the throw happens before the return — so the
 * reservation would leak for the rest of the window with nothing left holding a
 * reference to it. Worse on the FIRST write of a window: the call that throws is the
 * `expire` that would have armed the TTL, so the leaked counter has NO expiry at all
 * until some later submit's `ttl < 0` branch re-arms it and extends the burn another
 * ~25h.
 *
 * All three legs (platform, run-for-real, consent) share this function so the unwind
 * cannot be missed at one call site.
 *
 * Still fails CLOSED — the error is rethrown after the unwind, so the submit aborts.
 * The unwind is best-effort (`refundBlockBuzzSpend` never throws); a lost unwind
 * over-counts, which only makes the cap STRICTER.
 */
export async function reserveCumulativeBuzzKey(
  key: RedisKeyTemplateSys,
  cost: number,
  ttlSeconds: number
): Promise<number> {
  const amount = Math.ceil(cost);
  const total = await sysRedis.incrBy(key, amount);
  try {
    if (total <= amount) {
      await sysRedis.expire(key, ttlSeconds);
    } else {
      const ttl = await sysRedis.ttl(key);
      if (ttl < 0) await sysRedis.expire(key, ttlSeconds);
    }
  } catch (e) {
    await refundBlockBuzzSpend(key, amount);
    throw e;
  }
  return total;
}

/**
 * Atomically reserves `cost` against this user's cumulative UTC-day counter and
 * returns the new running total. INCRBY is atomic, so concurrent submits
 * accumulate correctly with no read→check→record TOCTOU. A Redis error throws and
 * fails the submit CLOSED — see
 * `reserveCumulativeBuzzKey` for the TTL arming and the self-unwind.
 */
export async function reserveBlockBuzzSpend(
  userId: number,
  cost: number
): Promise<{ total: number; key: ReturnType<typeof buzzCapRedisKey> }> {
  const key = buzzCapRedisKey(userId);
  const total = await reserveCumulativeBuzzKey(key, cost, BLOCK_BUZZ_CAP_TTL_SECONDS);
  // Return the resolved key so the caller refunds against the EXACT same key it
  // reserved — see refundBlockBuzzSpend for why re-deriving is unsafe.
  return { total, key };
}

/**
 * Refunds a previously-reserved `cost` (best-effort DECRBY) against the EXACT
 * key returned by reserveBlockBuzzSpend. Used when the reservation pushed the
 * total over the cap, or when the submit path throws before a resolved
 * submitWorkflow. Best-effort: a failed refund leaves the reservation in place,
 * which OVER-counts and so only makes the cap STRICTER — the safe direction for
 * an abuse cap. Never throws into the caller.
 *
 * Takes the reserved key rather than re-deriving it from userId: the key embeds
 * the UTC-day window, and the throw-path refund runs AFTER the (multi-second)
 * submitWorkflow, so re-deriving could land on the NEXT day's key if the request
 * straddled midnight UTC — decrementing an empty key to a negative, TTL-less
 * value and handing the user a window of extra cap headroom. Pinning the key
 * eliminates that race.
 */
export async function refundBlockBuzzSpend(key: string, cost: number): Promise<void> {
  await sysRedis.decrBy(key, Math.ceil(cost)).catch(() => {
    /* best-effort — see note above; a lost refund over-counts (stricter cap) */
  });
}
