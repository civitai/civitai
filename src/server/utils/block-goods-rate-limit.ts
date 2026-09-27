import { createHash } from 'crypto';
import { redis, REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

/**
 * Rate limit, daily cap and idempotency for the App Blocks DIGITAL GOODS
 * purchase endpoint (`POST /api/v1/blocks/goods/purchase`).
 *
 * Deliberately the same shape as `block-tip-rate-limit.ts`: that module is the
 * reviewed, hardened posture for a block money path (fail-CLOSED limiter,
 * atomic reserve-and-refund daily cap keyed per USER, and a fingerprinted
 * `SET NX` idempotency claim). This is a sibling surface with its own buckets,
 * not a variation on the rules.
 *
 * The claim state machine here is the third copy in the tree (gen, tip, goods).
 * Consolidating the three is worth doing and is deliberately NOT done here —
 * it would re-open two live money paths inside a change that adds a third.
 */

// A purchase is a deliberate, one-per-good act, not something a UI taps
// repeatedly: a good can be bought exactly once, so a legitimate client makes
// at most a handful of calls a minute (a mis-tap, a retry, a second good).
// Tighter than the tip limiter for that reason.
export const BLOCK_GOOD_RATE_LIMIT_MAX = 6;
export const BLOCK_GOOD_RATE_LIMIT_WINDOW_SECONDS = 60;

export type BlockGoodRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Records one purchase attempt against `blockInstanceId`'s window and reports
 * whether it is within the per-instance ceiling. FAIL-CLOSED on any redis error
 * — a money-moving endpoint must not become unbounded when its limiter is down.
 */
export async function checkBlockGoodRateLimit(
  blockInstanceId: string
): Promise<BlockGoodRateLimitResult> {
  const key = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:goods:${blockInstanceId}` as const;
  try {
    const count = await redis.incrBy(key as never, 1);
    if (count === 1) {
      await redis.expire(key as never, BLOCK_GOOD_RATE_LIMIT_WINDOW_SECONDS);
    } else {
      const ttl = await redis.ttl(key as never);
      if (ttl < 0) await redis.expire(key as never, BLOCK_GOOD_RATE_LIMIT_WINDOW_SECONDS);
    }

    if (count <= BLOCK_GOOD_RATE_LIMIT_MAX) return { allowed: true };

    let retryAfter = await redis.ttl(key as never);
    if (!Number.isFinite(retryAfter) || retryAfter < 1) {
      retryAfter = BLOCK_GOOD_RATE_LIMIT_WINDOW_SECONDS;
    }
    return { allowed: false, retryAfterSeconds: retryAfter };
  } catch {
    return { allowed: false, retryAfterSeconds: BLOCK_GOOD_RATE_LIMIT_WINDOW_SECONDS };
  }
}

// ── Daily goods-spend cap ────────────────────────────────────────────────────
//
// Per-USER aggregate across EVERY installed app (the key omits appBlockId,
// mirroring BLOCK_TIP_CAP_PER_DAY), so a publisher cannot multiply a viewer's
// ceiling by shipping N apps. Set above the tip ceiling because a good is
// review-gated — a moderator saw its price — where a tip recipient is not.
export const BLOCK_GOOD_CAP_PER_DAY = 150_000;
// 25h: covers a UTC-day window plus skew. The key is re-derived per day, so a
// stale counter never bleeds into the next window.
const BLOCK_GOOD_CAP_TTL_SECONDS = 25 * 60 * 60;

function goodsCapWindowKey(): string {
  return new Date().toISOString().slice(0, 10); // UTC calendar day
}

function goodsCapRedisKey(userId: number): `${typeof REDIS_SYS_KEYS.BLOCKS.GOODS_CAP}:${string}` {
  return `${REDIS_SYS_KEYS.BLOCKS.GOODS_CAP}:${userId}:${goodsCapWindowKey()}`;
}

/**
 * Atomically reserves `amount` against this user's cumulative UTC-day goods
 * counter and returns the new running total plus the exact key reserved.
 * INCRBY is atomic, so concurrent purchases accumulate with no
 * read→check→record TOCTOU. No try/catch: a redis error throws and fails the
 * purchase CLOSED. The caller compares `total` against BLOCK_GOOD_CAP_PER_DAY
 * and refunds via the returned key on over-cap or on any downstream failure.
 */
export async function reserveBlockGoodSpend(
  userId: number,
  amount: number
): Promise<{ total: number; key: ReturnType<typeof goodsCapRedisKey> }> {
  const key = goodsCapRedisKey(userId);
  const total = await sysRedis.incrBy(key, Math.ceil(amount));
  if (total <= Math.ceil(amount)) {
    await sysRedis.expire(key, BLOCK_GOOD_CAP_TTL_SECONDS);
  } else {
    const ttl = await sysRedis.ttl(key);
    if (ttl < 0) await sysRedis.expire(key, BLOCK_GOOD_CAP_TTL_SECONDS);
  }
  return { total, key };
}

/**
 * Refunds a previously-reserved `amount` (best-effort DECRBY) against the EXACT
 * key `reserveBlockGoodSpend` returned — not a re-derived one, so a request
 * straddling midnight UTC refunds the day it reserved. Never throws: a lost
 * refund over-counts, which only makes the cap STRICTER (the safe direction).
 */
export async function refundBlockGoodSpend(
  key: ReturnType<typeof goodsCapRedisKey>,
  amount: number
): Promise<void> {
  await sysRedis.decrBy(key, Math.ceil(amount)).catch(() => {
    /* best-effort — a lost refund over-counts (stricter cap) */
  });
}

// ── Purchase idempotency ─────────────────────────────────────────────────────
//
// Fast path only. The AUTHORITATIVE dedupe is the deterministic
// `externalTransactionIdPrefix` the purchase is charged under (the Buzz ledger
// refuses a second charge on it) plus the UNIQUE `buzz_transaction_id` on
// `block_good_purchase`, which is how a conflict becomes observable. This
// sentinel exists so two CONCURRENT attempts never both reach the charge, and
// so a lost-response retry replays the first terminal body verbatim.

const BLOCK_GOOD_IDEM_TTL_SECONDS = 10 * 60;

/**
 * Per-(user, APP, key). `appBlockId` is load-bearing: the endpoint accepts any
 * `[A-Za-z0-9_-]{1,64}` key, so two apps the same user installed that pick the
 * same literal value would otherwise share one slot and app B would replay
 * app A's body. INJECTIVE on `:` — userId is numeric, appBlockId is a prefixed
 * ULID or a synthetic id, and the key charset excludes `:`.
 */
function goodsIdemRedisKey(
  userId: number,
  appBlockId: string,
  idempotencyKey: string
): `${typeof REDIS_SYS_KEYS.BLOCKS.GOODS_IDEM}:${number}:${string}:${string}` {
  return `${REDIS_SYS_KEYS.BLOCKS.GOODS_IDEM}:${userId}:${appBlockId}:${idempotencyKey}`;
}

/**
 * Pins an idempotency key to ONE logical purchase. Reusing a key for a
 * different good — or the same good at a different price — must not replay the
 * first result, because that would tell the app a purchase it never made
 * succeeded. Truncated to 32 hex chars: collision-irrelevant at this
 * cardinality and it keeps the stored record small.
 */
export function computeGoodPurchaseFingerprint(input: {
  appBlockId: string;
  goodId: string;
  priceBuzz: number;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([input.appBlockId, input.goodId, input.priceBuzz]))
    .digest('hex')
    .slice(0, 32);
}

export type BlockGoodIdempotencyClaim =
  | { state: 'acquired'; key: ReturnType<typeof goodsIdemRedisKey> }
  | { state: 'replay'; status: number; body: unknown }
  | { state: 'in_progress' }
  | { state: 'mismatch' };

/**
 * Atomically CLAIM the idempotency key for a purchase attempt. THROWS on a
 * redis error (fail-CLOSED; the caller maps it to a retryable 503).
 *
 * The stored record is always JSON: `{ fp }` while in progress, `{ fp, status,
 * body }` once terminal — a numeric `status` is what distinguishes them.
 */
export async function claimGoodIdempotency(
  userId: number,
  appBlockId: string,
  idempotencyKey: string,
  fingerprint: string
): Promise<BlockGoodIdempotencyClaim> {
  const key = goodsIdemRedisKey(userId, appBlockId, idempotencyKey);
  const claimed = await sysRedis.set(key, JSON.stringify({ fp: fingerprint }), {
    NX: true,
    EX: BLOCK_GOOD_IDEM_TTL_SECONDS,
  });
  if (claimed) return { state: 'acquired', key };

  const existing = await sysRedis.get(key);
  // SET→GET race (the winner released or expired the key in between). Treat as
  // in-progress rather than risk racing a live first attempt into a 2nd charge.
  if (existing == null) return { state: 'in_progress' };

  let parsed: { fp?: unknown; status?: unknown; body?: unknown };
  try {
    parsed = JSON.parse(existing) as typeof parsed;
  } catch {
    // Never re-run a money path on a value we cannot read.
    return { state: 'in_progress' };
  }
  if (parsed?.fp !== fingerprint) return { state: 'mismatch' };
  if (typeof parsed.status === 'number')
    return { state: 'replay', status: parsed.status, body: parsed.body };
  return { state: 'in_progress' };
}

/**
 * Persist the TERMINAL {status, body} of the first attempt so a lost-response
 * retry replays it. Carries the fingerprint forward so the mismatch check still
 * applies to the terminal record. Best-effort: it never throws into an
 * already-successful response.
 */
export async function finalizeGoodIdempotency(
  key: ReturnType<typeof goodsIdemRedisKey>,
  status: number,
  body: unknown,
  fingerprint: string
): Promise<void> {
  try {
    await sysRedis.set(key, JSON.stringify({ fp: fingerprint, status, body }), {
      EX: BLOCK_GOOD_IDEM_TTL_SECONDS,
    });
  } catch {
    /* best-effort — see doc comment */
  }
}

/**
 * Release the claim for a TRANSIENT outcome (429/503) so a genuine retry can
 * execute. Safe because a transient rejection means no money moved and no
 * reservation stands. Best-effort; never throws.
 */
export async function releaseGoodIdempotency(
  key: ReturnType<typeof goodsIdemRedisKey>
): Promise<void> {
  await sysRedis.del(key).catch(() => {
    /* best-effort — a stuck sentinel just 409s a retry until its short TTL */
  });
}

/** The viewer's current daily goods allowance, from the enforcing counter. */
export type BlockGoodAllowance = { cap: number; spent: number; remaining: number };

/**
 * Reads the viewer's daily goods allowance from the SAME counter the
 * reserve/refund path mutates. `spent` is reservation-based, so it can briefly
 * OVER-count between a reserve and its refund — the safe direction
 * (under-reports `remaining`). Throws on a redis error, like the reserve path.
 */
export async function readBlockGoodAllowance(userId: number): Promise<BlockGoodAllowance> {
  const key = goodsCapRedisKey(userId);
  const raw = await sysRedis.get(key);
  const parsed = raw == null ? 0 : Number.parseInt(raw, 10);
  const spent = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  return {
    cap: BLOCK_GOOD_CAP_PER_DAY,
    spent,
    remaining: Math.max(0, BLOCK_GOOD_CAP_PER_DAY - spent),
  };
}
