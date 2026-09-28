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
 * Records one purchase attempt against this VIEWER's window on this block
 * instance and reports whether it is within the ceiling. FAIL-CLOSED on any
 * redis error — a money-moving endpoint must not become unbounded when its
 * limiter is down.
 *
 * 🔴 THE BUYER IS PART OF THE KEY, AND THAT IS THE WHOLE POINT. Keyed on
 * `blockInstanceId` ALONE this limiter is not per-viewer at all for a PAGE app:
 * a page block has no per-viewer instance row, so its `blockInstanceId` is the
 * SYNTHETIC, SHARED `page_<appBlockId>` (see the page-token mint). Every viewer
 * of a page app therefore incremented ONE bucket, making the ceiling
 * `BLOCK_GOOD_RATE_LIMIT_MAX` purchases per minute for the ENTIRE PLATFORM on
 * that app — and because the limiter fails CLOSED, the seventh buyer in a
 * minute is refused rather than merely slowed. An iframe block, which does get
 * a real per-viewer instance id, was unaffected, which is exactly why this
 * reads as correct until a page app tries to sell something.
 *
 * Keeping `blockInstanceId` in the key as well as the buyer is deliberate: it
 * preserves the per-app granularity the ceiling was chosen for, so one app
 * misbehaving cannot spend another app's budget for the same viewer.
 *
 * ⚠ THE HAZARD ABOVE WAS NOT DISCOVERED HERE. `block-catalog-rate-limit.ts`
 * records it for the catalog bucket, attributed to clawgate #569, and that
 * round DEFERRED the fix on purpose — "the number is live and moving it is a
 * separate decision with its own blast radius". This module departs from that
 * decision for ONE reason: goods has provably never sold (`block_good_purchase`
 * is empty), so changing its bucket alters no live behaviour. The deferral
 * still stands for the catalog, tip and generation buckets.
 *
 * Positional, `(blockInstanceId, buyerUserId)`, to match
 * `checkBlockGoodReadRateLimit` below — its ONLY sibling, in this same file.
 * An earlier draft took an object and justified it as stopping a transposed
 * call; that rationale was false (the two parameters are `string` and `number`,
 * so a swap was already a compile error) and it put two calling conventions in
 * one module 290 lines apart. Consolidating the two functions would be better
 * still and is deliberately not attempted here; see the PR.
 */
export async function checkBlockGoodRateLimit(
  blockInstanceId: string,
  buyerUserId: number
): Promise<BlockGoodRateLimitResult> {
  const key =
    `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:goods:${blockInstanceId}:${buyerUserId}` as const;
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
// 🔴 THERE IS NO PER-APP GOODS CEILING, AND THAT IS A KNOWN GAP, NOT AN OVERSIGHT.
// `app-spend-cap.service.ts` exists because a per-USER cap cannot see
// CONCENTRATION: a Sybil ring of N accounts each gets its own daily ceiling and
// all of it can be funnelled through ONE app — which is exactly the shape of a
// route where 70% of the Buzz lands in that app owner's own balance. Goods are
// not wired into it here because `reserveAppSpend` also consumes the app's
// GENERATION velocity slots, so calling it from a purchase would throttle
// generation as a side effect of a sale. The honest reuse is its daily leg plus
// `resolveAppCapLimits(appBlockId).dailyBuzz`, and it needs its own decision
// about what the goods ceiling should be.
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
  // 🔴 try/catch, NOT `.catch()`. A promise handler catches a REJECTION; it does
  // not catch a SYNCHRONOUS throw from the call itself, which is what a
  // not-ready client does. Measured: with `.catch()` this rejected instead of
  // resolving, and the escape landed in the endpoint's over-cap arm — turning a
  // clean 400 into a 500 on the one path whose whole job is refusing cleanly.
  try {
    await sysRedis.decrBy(key, Math.ceil(amount));
  } catch {
    /* best-effort — a lost refund over-counts (stricter cap) */
  }
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
  /**
   * The price the CALLER asserted, when it sent one.
   *
   * 🔴 Part of the fingerprint, and omitting it was a real gap: `priceBuzz` is
   * the CATALOG price, and two requests can agree on it while disagreeing about
   * what the client believes. A retry reusing the key with a different
   * `expectedPriceBuzz` would then replay the first attempt's 200 instead of
   * earning the price-guard refusal it asked for — which is exactly the case
   * this fingerprint's own contract claims to cover.
   */
  expectedPriceBuzz?: number;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.appBlockId,
        input.goodId,
        input.priceBuzz,
        input.expectedPriceBuzz ?? null,
      ])
    )
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
  // 🔴 BOTH unreadable shapes get the SAME treatment, and they did not. A value
  // that is valid JSON but not an object (`null`, `123`, `"x"`) has no readable
  // `fp`, so it used to fall through to the mismatch branch and 422 with "this
  // key was already used for a DIFFERENT purchase" — a false statement about the
  // caller, and terminal-looking, for the whole TTL. It is the same fact as an
  // unparseable string: we cannot read the record.
  // `Array.isArray` is part of the test, not decoration: `typeof [] === 'object'`
  // and an array is not null, so a stored `[]` would otherwise walk straight past
  // this guard into the mismatch branch — the exact case being closed.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { state: 'in_progress' };
  }
  if (parsed.fp !== fingerprint) return { state: 'mismatch' };
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
  // 🔴 try/catch for the same reason as `refundBlockGoodSpend`, and here the
  // consequence is worse: this is called from the endpoint's
  // `catch (e) { release; throw e }` recovery, so a synchronous throw would
  // REPLACE the original error and leave the sentinel to 409 every retry for its
  // full TTL — precisely the wedge that recovery path exists to prevent.
  try {
    await sysRedis.del(key);
  } catch {
    /* best-effort — a stuck sentinel just 409s a retry until its short TTL */
  }
}

// ── The entitlements READ limiter ─────────────────────────────────────────────

// Generous: this is a bounded index read a block makes on mount and may refresh.
// The ceiling exists to bound a loop, not to shape traffic.
export const BLOCK_GOOD_READ_RATE_LIMIT_MAX = 120;
export const BLOCK_GOOD_READ_RATE_LIMIT_WINDOW_SECONDS = 10;

/**
 * Per-(instance, VIEWER) limiter for `GET /api/v1/blocks/entitlements`.
 *
 * 🔴 ITS OWN BUCKET, KEYED ON THE VIEWER TOO, AND THAT SECOND KEY SEGMENT IS THE
 * WHOLE REASON THIS EXISTS. The obvious choice was the shared
 * `checkBlockCatalogRateLimit` bucket every sibling block read uses — but that
 * one keys on `blockInstanceId` ALONE, and for a PAGE app the instance id is the
 * synthetic `page_<appBlockId>`: one string shared by every concurrent viewer of
 * that app, platform-wide. An entitlements read is made on mount, so on a busy
 * page app a viewer would be refused because of strangers' traffic — and a
 * refused entitlements read renders as "you own nothing", which is the worst
 * possible failure for a surface whose entire job is telling a viewer what they
 * bought. The `:poll:` bucket in `block-catalog-rate-limit.ts` departed from its
 * siblings' key for exactly this reason.
 *
 * Taking its own bucket also leaves the catalog ceiling alone: that number is
 * derived from how many times one page load charges it, and adding a sixth
 * charge would have cut every app's concurrent-page-load headroom by ~17%.
 *
 * FAIL-OPEN, unlike the purchase limiter: this moves no money, and failing a
 * read closed would tell a viewer they own nothing because Redis blinked.
 */
export async function checkBlockGoodReadRateLimit(
  blockInstanceId: string,
  userId: number
): Promise<BlockGoodRateLimitResult> {
  const key =
    `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:goods-read:${blockInstanceId}:${userId}` as const;
  try {
    const count = await redis.incrBy(key as never, 1);
    if (count === 1) {
      await redis.expire(key as never, BLOCK_GOOD_READ_RATE_LIMIT_WINDOW_SECONDS);
    } else {
      const ttl = await redis.ttl(key as never);
      if (ttl < 0) await redis.expire(key as never, BLOCK_GOOD_READ_RATE_LIMIT_WINDOW_SECONDS);
    }

    // A non-numeric reply would make `undefined <= max` false and refuse a read
    // for no reason; on a FAIL-OPEN bucket the safe reading of "I cannot tell" is
    // allow. (The purchase limiter's posture is the opposite, deliberately.)
    if (typeof count !== 'number' || !Number.isFinite(count)) return { allowed: true };
    if (count <= BLOCK_GOOD_READ_RATE_LIMIT_MAX) return { allowed: true };

    let retryAfter = await redis.ttl(key as never);
    if (!Number.isFinite(retryAfter) || retryAfter < 1) {
      retryAfter = BLOCK_GOOD_READ_RATE_LIMIT_WINDOW_SECONDS;
    }
    return { allowed: false, retryAfterSeconds: retryAfter };
  } catch {
    return { allowed: true };
  }
}
