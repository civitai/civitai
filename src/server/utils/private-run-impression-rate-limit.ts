import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { recordPrivateRunImpressionRateLimitRefusal } from '~/server/metrics/app-block-runtime.metrics';

/**
 * COST ceiling on the expensive leg of the private-run analytics gate
 * (`blocks/private-run-impression.service.ts`). Not an authorization control — the gate
 * takes no access decision and grants nothing.
 *
 * WHY IT EXISTS: `isPrivateRunImpression` runs on BOTH `blockRenders` writers, one of them
 * a public fire-and-forget beacon that fires once per host mount, and its last gate calls
 * `resolvePrivateRunAccess` — 4–9 single-row queries, one of them on the WRITE PRIMARY —
 * on an `appBlockId` taken from the REQUEST BODY. Before that gate existed the common
 * beacon path did ZERO Postgres queries. Once the private-run flag admits anyone, a
 * signed-in caller sending a confirmed-non-approved app id can therefore provoke that
 * work at whatever rate they like. This bounds it.
 *
 * ── THE KEY IS THE VIEWER, AND ONLY THE VIEWER ───────────────────────────────
 * 🔴 `appBlockId` MUST NOT BE IN THE KEY. It is caller-chosen, so a viewer+app key hands
 * out a fresh bucket for every id a caller invents and the ceiling bounds nothing at all —
 * the same rotation defect `block-catalog-rate-limit.ts` records about keying on a `jti`.
 * DELIBERATE CONTRAST with `REDIS_SYS_KEYS.BLOCKS.PRIVATE_RUN_BUZZ_CAP`, which DOES key on
 * `<viewer>:<appBlockId>`: that is a per-app spend BUDGET, and per-app is exactly what a
 * budget wants. A cost limiter wants the opposite, and this is the kind of thing the next
 * editor gets wrong by symmetry. Its own key prefix, so the two buckets can never draw
 * each other down.
 *
 * ── BOTH FAILURE DIRECTIONS, AND NEITHER IS THE OBVIOUS ONE ──────────────────
 * 🔴 OVER THE CEILING ⇒ the CALLER's impression is RECORDED, never suppressed. Read the
 * gate's polarity: `true` means "suppress this impression", so refusing by returning
 * "suppress" would hand every viewer a way to hide their own impressions by deliberately
 * exhausting their own window — and the gate's docblock is explicit that a client-settable
 * suppression is a LARGER defect than the leak it closes. The caller therefore treats a
 * refusal exactly like its `catch`: FAIL TOWARD RECORDING THE IMPRESSION.
 *
 * ⚠️ AND STATE THE COST OF THAT PLAINLY: above the ceiling a genuine reviewer's private-run
 * impressions ARE recorded, so they become visible to the app's owner. The
 * owner-invisibility guarantee degrades above the ceiling rather than the cost bound
 * degrading. That is why the ceiling sits far above any real review session's mount rate,
 * and why a refusal emits a counter instead of being silent — a refusal here has a
 * CORRECTNESS consequence, not merely a throttling one.
 *
 * 🔴 A REDIS ERROR OR A BAD REPLY ⇒ FAIL OPEN, i.e. PROCEED TO THE EXPENSIVE QUERY. Same
 * convention as every blocks limiter, but the INVERSION is worth naming: for an ordinary
 * limiter fail-open means "serve the request", and here it means "pay for the queries", so
 * a Redis incident removes the COST BOUND rather than removing a protection. That is the
 * right trade — a cache incident must not start leaking review activity into owners'
 * analytics panels — but it is a trade, not a free choice.
 *
 * ── THE COST BOUND, WITH ITS ARITHMETIC ─────────────────────────────────────
 * ≤ 30 reaching calls / minute / viewer ⇒ ≤ 30 × 9 = 270 single-row queries / minute /
 * viewer, of which ≤ 30 touch the WRITE PRIMARY (the predicate reads the viewer row there
 * by its own deliberate choice; everything else goes to the replica). A human mounting a
 * host 30× a minute is already pathological, and the audience for this surface is
 * moderators plus an app's own owner and accepted collaborators.
 *
 * ⚠️ STATED LIMITS, so this is not read as more than it is: a FIXED window, so a 2× burst
 * across a boundary is reachable by construction. It is a cost bound, not a guarantee.
 *
 * ── WHY NO TTL SELF-HEAL, UNLIKE TWO OF ITS SIBLINGS ────────────────────────
 * `apps-catalog-rate-limit.ts` and `block-catalog-rate-limit.ts` both re-assert a missing
 * TTL. The second NEEDS it: its `INCR`-then-`EXPIRE` is not atomic, so a crash between the
 * two strands an immortal key. This bucket's key can only be CREATED by the `SET … NX EX`
 * inside the MULTI, which carries the expiry in the same command, so a TTL-less window is
 * unreachable here and a self-heal would be a second Redis round-trip on every call past
 * the first, on the path this file exists to make cheaper.
 */

export const PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX = 30;
export const PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS = 60;

export type PrivateRunImpressionRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Records ONE reaching call against `viewerId`'s window and reports whether it is within
 * the ceiling.
 *
 * @param viewerId the SERVER-RESOLVED session user's id. Never anything parsed from a
 *   request body — a body-derived subject would be rotatable, which is the whole reason
 *   the app id is kept out of the key.
 * @returns `{ allowed: true }` under the ceiling, and on ANY limiter failure (fail-open,
 *   see the docblock); `{ allowed: false, retryAfterSeconds }` once the window's count
 *   exceeds the ceiling.
 */
export async function checkPrivateRunImpressionRateLimit(
  viewerId: number
): Promise<PrivateRunImpressionRateLimitResult> {
  const key = `${REDIS_SYS_KEYS.BLOCKS.PRIVATE_RUN_IMPRESSION_RATE_LIMIT}:${viewerId}` as const;

  try {
    // ATOMIC WINDOW ARMING: the `SET … NX EX` creates the counter WITH its expiry, so the
    // TTL can never be missing. `INCR` in the same MULTI returns this call's count.
    const multiResult = await sysRedis
      .multi()
      .set(key, '0', { NX: true, EX: PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS })
      .incr(key)
      .exec();
    const count = multiResult?.[1];

    // 🔴 FAIL OPEN ON A NON-THROWING BAD REPLY, NOT ONLY ON A THROW — a `catch` guards
    // against THROWS, this guards against ANSWERS. It is load-bearing because of the
    // comparison's polarity below: `undefined <= 30` is FALSE, so without this line an
    // `undefined`/`null`/`NaN` reply falls through to the refusal branch and the limiter
    // fails CLOSED, against everything this file's docblock promises. (The polarity is
    // deliberate: written the other way round — `if (count > max) refuse` — a bad reply
    // would coincidentally fail open and this guard would be unreachable, i.e. a guard
    // nobody could ever watch work.)
    if (typeof count !== 'number' || !Number.isFinite(count)) return { allowed: true };
    if (count <= PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX) return { allowed: true };

    // Over the ceiling. Surface the remaining window so a caller could back off; if the
    // TTL read fails or is unset (-1/-2) fall back to the full window rather than to an
    // immediate retry.
    let retryAfterSeconds = await sysRedis.ttl(key).catch(() => -1);
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 1)
      retryAfterSeconds = PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS;

    // 🔴 EMITTED HERE RATHER THAN AT THE CALL SITE, and NOT because it is tidier: the
    // counter measures THE GATE, which is shared by both `blockRenders` writers, so one
    // emit inside the one decision covers both by construction. The gate is also the
    // reason there is no `app_block_id` label — see the emitter's own docblock.
    recordPrivateRunImpressionRateLimitRefusal();
    return { allowed: false, retryAfterSeconds };
  } catch {
    // FAIL OPEN — see the docblock. Here that means "pay for the queries", not "serve".
    return { allowed: true };
  }
}
