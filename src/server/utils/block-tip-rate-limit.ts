import { createHash } from 'crypto';
import { redis, REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

/**
 * Per-instance fixed-window rate limit for the App Blocks TIP endpoint
 * (`POST /api/v1/blocks/tip`).
 *
 * WHY: tipping moves REAL Buzz out of the viewer's account. The underlying
 * `createBuzzTipTransactionHandler` already enforces balance, self-tip, banned,
 * blocked, and 24h-account gates, but a block that hammered the endpoint (a UI
 * bug or a hostile iframe) could still churn many small tips + notifications.
 * This bounds the per-instance tip RATE without touching the money-authority
 * surface (the handler stays the sole arbiter of whether a tip is allowed).
 *
 * PATTERN: reuses the established blocks fixed-window limiter — the SAME
 * INCR + EXPIRE shape as `checkBlockCatalogRateLimit` /
 * `BlockTokenService.checkRateLimit`, on the `redis` cache client, under a
 * distinct `:tip:` sub-namespace so it never contends with the mint-token or
 * catalog buckets.
 *
 * KEY: `claims.blockInstanceId` — the stable per-instance identity the same
 * in-block iframe reuses. We key on the instance (not `jti`, which rotates on
 * every re-mint) so an abuser can't churn tokens for a fresh bucket.
 *
 * FAIL-CLOSED: unlike the catalog limiter (which fails OPEN so a read surface
 * never breaks on a redis blip), the tip limiter fails CLOSED on a redis error
 * — a money-moving endpoint must not become unbounded when its limiter is down.
 * The caller surfaces this as a retryable 429/503.
 */

// CEILING: a human tipping through a player taps at most a handful of times a
// minute (tip creator / tip curator on the current media). 10 tips / 60s per
// instance is generous for real use and bounds a runaway loop / hostile churn.
export const BLOCK_TIP_RATE_LIMIT_MAX = 10;
export const BLOCK_TIP_RATE_LIMIT_WINDOW_SECONDS = 60;

export type BlockTipRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Records one tip attempt against `blockInstanceId`'s window and reports whether
 * it is within the per-instance ceiling.
 *
 * @param blockInstanceId stable per-instance identity from `req.blockClaims`.
 * @returns `{ allowed: true }` under the limit; `{ allowed: false,
 *   retryAfterSeconds }` once the window's count exceeds the ceiling OR on any
 *   redis error (FAIL-CLOSED — money path).
 */
export async function checkBlockTipRateLimit(
  blockInstanceId: string
): Promise<BlockTipRateLimitResult> {
  const key = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:tip:${blockInstanceId}` as const;
  try {
    const count = await redis.incrBy(key as never, 1);
    if (count === 1) {
      await redis.expire(key as never, BLOCK_TIP_RATE_LIMIT_WINDOW_SECONDS);
    } else {
      const ttl = await redis.ttl(key as never);
      if (ttl < 0) await redis.expire(key as never, BLOCK_TIP_RATE_LIMIT_WINDOW_SECONDS);
    }

    if (count <= BLOCK_TIP_RATE_LIMIT_MAX) return { allowed: true };

    let retryAfter = await redis.ttl(key as never);
    if (!Number.isFinite(retryAfter) || retryAfter < 1) {
      retryAfter = BLOCK_TIP_RATE_LIMIT_WINDOW_SECONDS;
    }
    return { allowed: false, retryAfterSeconds: retryAfter };
  } catch {
    // FAIL-CLOSED — a money-moving endpoint must not run unbounded when the
    // limiter's redis is unreachable. Surface a retryable back-off.
    return { allowed: false, retryAfterSeconds: BLOCK_TIP_RATE_LIMIT_WINDOW_SECONDS };
  }
}

// ── Tip amount caps (what makes block tipping PAGE-SAFE) ──────────────────────
// Tipping is money OUT to third parties and is NOT gated by the per-gen
// `buzzBudget` cost-preflight, so a page tip needs its OWN explicit bounds — the
// analogue of the gen-spend `buzzBudget` + `BLOCK_BUZZ_CAP_PER_DAY` pair. These
// two caps are the load-bearing safety that let `social:tip:self` come off
// PAGE_FORBIDDEN_SCOPES: a compromised/buggy block can neither drain an account
// in one call (per-tip cap) nor bleed it over a day (per-user daily cap).

// Per-single-tip ceiling. Bounds one call; a block can't move a large sum in one
// shot. Conservative vs. the gen per-call budget cap (1000) — a tip is a direct
// transfer to another user, but a legitimate creator tip can reasonably exceed
// 1000, so this is set higher while still hard-bounding a single request.
export const BLOCK_TIP_MAX_PER_TIP = 5_000;
// Per-USER daily aggregate across ALL of a user's installed blocks (the key omits
// appBlockId, mirroring BLOCK_BUZZ_CAP_PER_DAY, so a publisher can't multiply the
// ceiling by spinning up N blocks). Set BELOW the gen daily cap (50_000) because
// tips are irreversible transfers to third parties.
export const BLOCK_TIP_CAP_PER_DAY = 25_000;
// 25h TTL: covers a UTC-day window plus skew; the key is re-derived per day so a
// stale counter never bleeds into the next window.
const BLOCK_TIP_CAP_TTL_SECONDS = 25 * 60 * 60;

function tipCapWindowKey(): string {
  return new Date().toISOString().slice(0, 10); // UTC calendar day
}

function tipCapRedisKey(userId: number): `${typeof REDIS_SYS_KEYS.BLOCKS.TIP_CAP}:${string}` {
  // PER-USER aggregate: appBlockId is intentionally NOT part of the key.
  return `${REDIS_SYS_KEYS.BLOCKS.TIP_CAP}:${userId}:${tipCapWindowKey()}`;
}

/**
 * Atomically reserves `amount` against this user's cumulative UTC-day tip counter
 * and returns the new running total + the exact key reserved. INCRBY is atomic so
 * concurrent tips accumulate correctly with no read→check→record TOCTOU. Sets the
 * TTL on the (effectively) first write. No try/catch: a Redis error throws and
 * fails the tip CLOSED (mirrors reserveBlockBuzzSpend). Caller compares `total`
 * against BLOCK_TIP_CAP_PER_DAY and refunds via the returned key on over-cap /
 * on any downstream failure.
 */
export async function reserveBlockTipSpend(
  userId: number,
  amount: number
): Promise<{ total: number; key: ReturnType<typeof tipCapRedisKey> }> {
  const key = tipCapRedisKey(userId);
  const total = await sysRedis.incrBy(key, Math.ceil(amount));
  if (total <= Math.ceil(amount)) {
    await sysRedis.expire(key, BLOCK_TIP_CAP_TTL_SECONDS);
  } else {
    const ttl = await sysRedis.ttl(key);
    if (ttl < 0) await sysRedis.expire(key, BLOCK_TIP_CAP_TTL_SECONDS);
  }
  return { total, key };
}

/**
 * Refunds a previously-reserved tip `amount` (best-effort DECRBY) against the
 * EXACT key returned by reserveBlockTipSpend. Used when the reservation pushed the
 * total over the daily cap, or when the tip transaction throws (insufficient
 * funds, etc.). Best-effort: a failed refund leaves the reservation in place →
 * OVER-counts → the cap is only made STRICTER (the safe direction). Never throws.
 * Takes the reserved key (not re-derived) so a request straddling midnight UTC
 * refunds the day it reserved, not the next day's key.
 */
export async function refundBlockTipSpend(
  key: ReturnType<typeof tipCapRedisKey>,
  amount: number
): Promise<void> {
  await sysRedis.decrBy(key, Math.ceil(amount)).catch(() => {
    /* best-effort — a lost refund over-counts (stricter cap) */
  });
}

// ── Tip allowance READ (item 4) ──────────────────────────────────────────────

/** The daily tip allowance for a user: cap, net-reserved-today, and remaining. */
export type BlockTipAllowance = { cap: number; spent: number; remaining: number };

/**
 * Reads the viewer's CURRENT daily tip allowance from the SAME authoritative
 * `tip-cap` counter the reserve/refund path mutates — so a block can show a
 * genuinely-tracked remaining allowance instead of a dead client-side full-cap
 * guess (the opaque-origin sandbox has no working `localStorage`).
 *
 * `spent` is the RESERVATION-based net total (INCRBY on reserve, DECRBY on
 * refund), so it reflects net-committed-today and can briefly OVER-count between
 * a reserve and its refund — the SAFE direction (under-reports `remaining`,
 * never over-reports). `remaining` is clamped at 0 (a straddling over-cap
 * reservation could push the raw counter above the cap for an instant).
 *
 * FAIL-CLOSED on a redis error (throws) — the caller surfaces a retryable 503,
 * consistent with the reserve path. A read is not money-moving, but reporting a
 * fabricated full allowance on a redis blip would invite a block to let the user
 * tip past a ceiling the enforcing reserve would then reject; failing closed
 * keeps the read honest.
 */
export async function readBlockTipAllowance(userId: number): Promise<BlockTipAllowance> {
  const key = tipCapRedisKey(userId);
  const raw = await sysRedis.get(key);
  const parsed = raw == null ? 0 : Number.parseInt(raw, 10);
  const spent = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const remaining = Math.max(0, BLOCK_TIP_CAP_PER_DAY - spent);
  return { cap: BLOCK_TIP_CAP_PER_DAY, spent, remaining };
}

// ── Tip IDEMPOTENCY (item 2, tip half) ────────────────────────────────────────
//
// A tip moves REAL Buzz to a third party and is IRREVERSIBLE. `requestId` on the
// postMessage/HTTP layer is a fresh per-attempt correlation id, so a timeout /
// lost-response retry that re-POSTs the same logical tip would reserve AND charge
// twice. A CLIENT-generated `idempotencyKey` that is stable across the retry lets
// the endpoint collapse the replay to the FIRST terminal result.
//
// PATTERN (money-safe, not merely "block the second call"):
//   claim  — SET NX the idem key to an in-progress sentinel BEFORE reserve/charge.
//            first caller wins → { state: 'acquired' }.
//            key already holds a TERMINAL result → { state: 'replay', … } (the
//            endpoint returns it VERBATIM — no second reserve, no second charge).
//            key still in-progress (or a lost/garbage value) → { state: 'in_progress' }
//            → the endpoint 409s so a still-running first attempt is never raced
//            into a double charge.
//   finalize — overwrite the sentinel with the TERMINAL {status, body} so a later
//              lost-response retry replays it. Best-effort (never perturbs an
//              already-shipped response).
//   release  — delete the sentinel for a TRANSIENT outcome (429/503) so a genuine
//              retry can actually execute (no money moved → safe to re-attempt).
//
// FAIL-CLOSED: `claim` THROWS on a redis error (the caller maps it to a 503),
// mirroring the reserve path — a money endpoint must not run its dedupe blind.

// Covers realistic lost-response / user-reload retry windows without pinning a
// stuck in-progress marker for long if `finalize` is ever lost on a redis blip.
const BLOCK_TIP_IDEM_TTL_SECONDS = 10 * 60;

/**
 * Per-(user, APP, key) redis key (audit 🟡-2).
 *
 * 🔴 `appBlockId` is load-bearing, not decoration. Without it the key is
 * `<userId>:<key>`, and the REST endpoint accepts ANY `[A-Za-z0-9_-]{1,64}` value
 * — so two apps the SAME user has installed that happen to pick the same literal
 * key (an app hardcoding `"tip1"`) share ONE idempotency slot. App B would then
 * REPLAY app A's cached response body verbatim, LEARNING A's tip recipient and
 * amount, while B's own tip silently never happens. Mirrors the gen key shape in
 * `block-gen-idempotency.ts`, which already carried the app segment.
 *
 * INJECTIVE on `:` because `userId` is numeric, `appBlockId` is an `apb_<ULID>` or
 * a synthetic `ephemeral-` / `page_local_` / `pubreq_` id, and `idempotencyKey` is
 * charset-restricted to `^[A-Za-z0-9_-]{1,64}$` at the endpoint — none can contain
 * a colon, so no two distinct triples collide.
 */
function tipIdemRedisKey(
  userId: number,
  appBlockId: string,
  idempotencyKey: string
): `${typeof REDIS_SYS_KEYS.BLOCKS.TIP_IDEM}:${number}:${string}:${string}` {
  return `${REDIS_SYS_KEYS.BLOCKS.TIP_IDEM}:${userId}:${appBlockId}:${idempotencyKey}`;
}

/**
 * REQUEST FINGERPRINT (audit 🟡-1 residual). An idempotency key identifies ONE
 * logical request; reusing it for a DIFFERENT payload is a client bug, and
 * replaying the first result for it is actively misleading — the app is told "your
 * tip of B Buzz to Y succeeded" when what actually happened was a tip of A Buzz to
 * X. Stripe rejects that rather than replaying; so do we (the caller 422s).
 *
 * Covers exactly the fields that define the tip. `userId` + `appBlockId` are
 * already pinned by the redis key, so they are deliberately not repeated here.
 * Truncated to 32 hex chars — collision-irrelevant at this cardinality, and it
 * keeps the stored record small.
 */
export function computeTipFingerprint(input: {
  toUserId: number;
  amount: number;
  entityType?: string;
  entityId?: number;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.toUserId,
        input.amount,
        input.entityType ?? null,
        input.entityId ?? null,
      ])
    )
    .digest('hex')
    .slice(0, 32);
}

export type BlockTipIdempotencyClaim =
  | { state: 'acquired'; key: ReturnType<typeof tipIdemRedisKey> }
  | { state: 'replay'; status: number; body: unknown }
  | { state: 'in_progress' }
  | { state: 'mismatch' };

/**
 * Atomically CLAIM the idempotency key for a tip attempt. Fail-CLOSED (throws) on
 * a redis error so the caller returns a retryable 503 — a money endpoint must not
 * dedupe blind. See the block comment above for the state machine.
 *
 * The stored record is ALWAYS JSON: `{ fp }` while in progress, `{ fp, status, body }`
 * once terminal (a numeric `status` is what distinguishes them). A record whose `fp`
 * differs from THIS request's → `mismatch` (the caller 422s): the same key is being
 * reused for a different payload, so neither replaying the old result nor executing
 * the new tip is correct.
 */
export async function claimTipIdempotency(
  userId: number,
  appBlockId: string,
  idempotencyKey: string,
  fingerprint: string
): Promise<BlockTipIdempotencyClaim> {
  const key = tipIdemRedisKey(userId, appBlockId, idempotencyKey);
  // SET NX EX — first writer wins the in-progress sentinel. node-redis returns
  // 'OK' on set, null when the key already exists.
  const claimed = await sysRedis.set(key, JSON.stringify({ fp: fingerprint }), {
    NX: true,
    EX: BLOCK_TIP_IDEM_TTL_SECONDS,
  });
  if (claimed) return { state: 'acquired', key };

  // Key already exists — read it to decide mismatch vs replay vs still-in-progress.
  const existing = await sysRedis.get(key);
  if (existing == null) {
    // SET→GET race (the winner released or expired the key in between). Treat as
    // in-progress: 409 rather than risk racing a live first attempt into a 2nd charge.
    return { state: 'in_progress' };
  }
  let parsed: { fp?: unknown; status?: unknown; body?: unknown };
  try {
    parsed = JSON.parse(existing) as typeof parsed;
  } catch {
    // A malformed / partially-written record is treated as in-progress — never
    // re-run a money path on a value we cannot read.
    return { state: 'in_progress' };
  }
  if (parsed?.fp !== fingerprint) {
    // Same key, DIFFERENT request. Never replay someone else's outcome, and never
    // execute a second charge under a key that is already spoken for.
    return { state: 'mismatch' };
  }
  if (typeof parsed.status === 'number') {
    return { state: 'replay', status: parsed.status, body: parsed.body };
  }
  // Fingerprint matches but there is no terminal result yet — the first attempt is live.
  return { state: 'in_progress' };
}

/**
 * Persist the TERMINAL {status, body} of the FIRST attempt so a later
 * lost-response retry replays it. Best-effort: if the record can't be written,
 * the in-progress sentinel simply expires and a post-TTL retry may re-run
 * (a redis-down edge) — it never throws into an already-successful response.
 *
 * Carries the `fingerprint` forward so the mismatch check still applies to the
 * TERMINAL record (a replay under the same key with a DIFFERENT payload must 422,
 * not receive the old body).
 */
export async function finalizeTipIdempotency(
  key: ReturnType<typeof tipIdemRedisKey>,
  status: number,
  body: unknown,
  fingerprint: string
): Promise<void> {
  try {
    await sysRedis.set(key, JSON.stringify({ fp: fingerprint, status, body }), {
      EX: BLOCK_TIP_IDEM_TTL_SECONDS,
    });
  } catch {
    /* best-effort — see doc comment */
  }
}

/**
 * Release the idempotency claim for a TRANSIENT outcome (429/503) so a genuine
 * retry with the same key can execute. Safe because a transient rejection means
 * NO money moved and NO reservation stands. Best-effort; never throws.
 */
export async function releaseTipIdempotency(
  key: ReturnType<typeof tipIdemRedisKey>
): Promise<void> {
  await sysRedis.del(key).catch(() => {
    /* best-effort — a stuck sentinel just 409s a retry until its short TTL */
  });
}
