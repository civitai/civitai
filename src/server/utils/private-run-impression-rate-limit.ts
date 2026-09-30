import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
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
 * 🔴 A HANG IS NOT AN ERROR, AND THE `catch` CANNOT SEE ONE. The sys client carries no
 * socketTimeout (`REDIS_SYS_SOCKET_TIMEOUT_MS` defaults to 0) and a per-command timeout
 * does not bound a command once it has been WRITTEN, so on a silent half-open the MULTI
 * parks until OS TCP keepalive errors the socket. `/api/track/block-render` awaits the
 * gate above this UNWRAPPED and with no timeout of its own, so an unbounded await here
 * parks request handlers on a public, high-volume beacon — which is the fail-open promised
 * two paragraphs up turning into its exact opposite. `withSysReadDeadline` converts that
 * open-ended park into a rejection, which the `catch` below then handles as the fail-open
 * it already was. Same treatment, same shape, as `api/v1/blocks/submit-version.ts` — which
 * fails CLOSED on that rejection because a mod-gated bundle upload wants the opposite
 * trade.
 *
 * 🔴 AND THE FAIL-OPEN SAYS SO. Every fail-open arm emits `logSysRedisFailOpen`
 * (`rate-limit-write-degraded`, the subtype whose Loki alert already means "abuse
 * prevention is effectively disabled"). The refusal COUNTER cannot carry this: it grades a
 * ceiling BITING, and a limiter fault is the opposite reading — the bound is absent and
 * nothing was refused. Without the log, a sustained incident is indistinguishable from
 * health on every signal this file emits, precisely while the cost bound is gone. No
 * viewer id rides along, for the same reason the counter carries no labels.
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
  /**
   * `retryAfterSeconds` is the FULL window, as a constant — never a live TTL read.
   * Enumerated: the only production consumer (`blocks/private-run-impression.service.ts`
   * gate 3.5) reads `.allowed` and discards the rest, so a TTL round-trip here bought a
   * value nobody read while costing an extra unbounded sysRedis call on the REFUSAL path —
   * by definition the abuse path — and a synchronous throw from it escaped to the outer
   * catch, turning a DECIDED REFUSAL into an ALLOW with no counter emitted. The field
   * survives because it is the honest upper bound on the wait and is what a future caller
   * would surface as `Retry-After`; a fixed window makes the constant correct-by-construction
   * as an upper bound, and merely conservative as an estimate.
   */
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
    //
    // 🔴 RACED AGAINST THE SYS READ DEADLINE — see the docblock. A MULTI is exactly the
    // shape `withSysReadDeadline` exists for: its own note says a per-command timeout
    // "never bounds MULTI sub-commands", so this wall-clock race is the ONLY bound on the
    // handler's wait. On a breach it REJECTS (verified against the wrapper, not assumed),
    // which lands in the `catch` below and fails open like any other limiter fault. The
    // orphaned command settles in the background and is reaped by `Promise.race`.
    const multiResult = await withSysReadDeadline(
      sysRedis
        .multi()
        .set(key, '0', { NX: true, EX: PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS })
        .incr(key)
        .exec()
    );
    const count = multiResult?.[1];

    // 🔴 FAIL OPEN ON A NON-THROWING BAD REPLY, NOT ONLY ON A THROW — a `catch` guards
    // against THROWS, this guards against ANSWERS. It is load-bearing because of the
    // comparison's polarity below: `undefined <= 30` is FALSE, so without this line an
    // `undefined`/`null`/`NaN` reply falls through to the refusal branch and the limiter
    // fails CLOSED, against everything this file's docblock promises. (The polarity is
    // deliberate: written the other way round — `if (count > max) refuse` — a bad reply
    // would coincidentally fail open and this guard would be unreachable, i.e. a guard
    // nobody could ever watch work.)
    if (typeof count !== 'number' || !Number.isFinite(count)) {
      // A fail-open arm like the `catch`, and just as invisible without this. `err` is
      // `null` because nothing threw — the same shape `moderation-utils.ts` uses for its
      // non-throwing fail-open.
      logSysRedisFailOpen(
        'rate-limit-write-degraded',
        'checkPrivateRunImpressionRateLimit: malformed counter reply',
        null,
        { replyType: typeof count }
      );
      return { allowed: true };
    }
    if (count <= PRIVATE_RUN_IMPRESSION_RATE_LIMIT_MAX) return { allowed: true };

    // Over the ceiling. `retryAfterSeconds` is the window CONSTANT, not a live TTL read —
    // the type's own note above records the enumeration behind that and why the extra
    // round-trip was worse than the precision it bought.
    // 🔴 EMITTED HERE RATHER THAN AT THE CALL SITE, and NOT because it is tidier: the
    // counter measures THE GATE, which is shared by both `blockRenders` writers, so one
    // emit inside the one decision covers both by construction. The gate is also the
    // reason there is no `app_block_id` label — see the emitter's own docblock.
    recordPrivateRunImpressionRateLimitRefusal();
    return {
      allowed: false,
      retryAfterSeconds: PRIVATE_RUN_IMPRESSION_RATE_LIMIT_WINDOW_SECONDS,
    };
  } catch (err) {
    // FAIL OPEN — see the docblock. Here that means "pay for the queries", not "serve".
    // 🔴 AND SAY SO. This arm now also covers a deadline-bounded HANG, which is the arm a
    // sustained incident actually produces; silent, it reads as health on every other
    // signal this file emits. No viewer id — see the docblock.
    logSysRedisFailOpen('rate-limit-write-degraded', 'checkPrivateRunImpressionRateLimit', err);
    return { allowed: true };
  }
}
