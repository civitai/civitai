import type { NextApiRequest } from 'next';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { getTrustedClientIp, UNRESOLVED_CLIENT_IP } from '~/server/utils/client-ip';

/**
 * Per-IP rate limiter for the UNAUTHENTICATED client-error report endpoint
 * (`POST /api/application-error`).
 *
 * WHY THIS ENDPOINT NEEDS ONE. It is wrapped in `PublicEndpoint`, which applies
 * no limiter of its own, so before this module any caller could post to it at
 * will. What the endpoint produces is not a response — it is an operational
 * SIGNAL: each accepted report is forwarded to the log pipeline, and the volume
 * of those reports is what tells operators the front end is broken. An
 * unbounded single source can therefore manufacture that signal.
 *
 * WHAT THE CONTROL DOES. It bounds how much of that signal ONE client address
 * can contribute. It is deliberately NOT a general abuse gate — it does not
 * authenticate, does not block, and does not reduce the endpoint's cost to
 * anything close to zero. Its single property is:
 *
 *   no individual address can, by itself, drive the endpoint's accepted-report
 *   rate to the level that means "something is broken for many people"
 *
 * while leaving a genuine incident — many DISTINCT addresses reporting at once —
 * comfortably able to produce that level.
 *
 * ── THE LIMIT, AND WHY IT IS THIS NUMBER ──────────────────────────────────
 *
 * 30 reports / 60 s = 0.5 accepted reports per second, sustained, per address.
 *
 * Sized against both ends of the tension, because either end silently destroys
 * something if it is got wrong:
 *
 *  TOO TIGHT would suppress the reports we exist to collect. A single user
 *  hitting a client-side render loop posts repeatedly from ONE address, and
 *  that is a REAL defect we want to hear about. Measured against the endpoint's
 *  own traffic, 0.5/s per address is an order of magnitude above the busiest
 *  single sample ever observed for the WHOLE endpoint across every client
 *  (~0.4/s, against a steady state of ~0.009/s). So one address on its own is
 *  granted more budget than the entire endpoint has ever used at peak: ordinary
 *  traffic — including one user's loop — never reaches the ceiling, and the
 *  first 30 reports of any burst are always accepted, which is far more than
 *  the one report needed to diagnose a repeating stack.
 *
 *  TOO LOOSE would buy nothing. The rate that means "many people are affected"
 *  is a little above 5 accepted reports per second sustained. At 0.5/s an
 *  address supplies at most a TENTH of that, so reaching it takes at least
 *  ELEVEN distinct addresses all saturating their budget simultaneously — which
 *  is the many-distinct-users condition the signal is supposed to mean. A real
 *  front-end break affects far more clients than that and crosses the level
 *  without any of them coming near their individual ceiling.
 *
 * Both numbers are exported so a test asserts the ratio rather than restating
 * it, and so a future change to either has to be made where this reasoning is.
 *
 * ── THE COUNTER IS FLEET-WIDE, WHICH IS LOAD-BEARING ──────────────────────
 *
 * The counter lives in `sysRedis`, shared by every pod, so `MAX / WINDOW` is the
 * true per-address ceiling no matter how many pods serve the traffic. A
 * per-process counter would NOT have this property: requests from one address
 * are spread across pods, so the achievable rate would be (pods x MAX / WINDOW)
 * and would grow with the deployment. That is also why the redis-error branch
 * below does not fall back to an in-process counter — such a fallback would
 * carry the complexity of enforcement without the property that makes the
 * enforcement worth anything.
 *
 * ── FAIL OPEN ON A LIMITER ERROR ──────────────────────────────────────────
 *
 * A redis failure serves the request. This is not the reflexive default — it is
 * chosen, and the other direction was considered:
 *
 *  - Failing CLOSED would delete the primary front-end-break signal for the
 *    duration of an infrastructure incident, which is precisely when front-end
 *    breaks are most likely and least visible. A control that silently switches
 *    off the thing it protects is worse than the exposure it prevents.
 *  - The exposure from failing open is bounded and non-destructive: this
 *    endpoint returns no data, mints no credential, spends no money and writes
 *    no user-visible state. The worst case is that, while redis is down, the
 *    signal is as unbounded as it was before this module existed.
 *
 * The fail-open branch is LOGGED rather than silent, so a limiter that has
 * stopped limiting is observable instead of being indistinguishable from one
 * that is working. `console.warn` rather than the Axiom client on purpose: this
 * module is imported by a request path whose entire purpose is writing to that
 * pipeline, and routing the limiter's own failures into it would mean a redis
 * incident emits reports through the very channel it has degraded.
 */

export const APPLICATION_ERROR_RATE_LIMIT_MAX = 30;
export const APPLICATION_ERROR_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * The rate an address can sustain under the limit above, in requests per second.
 * Derived, never written down twice — a test compares it against the level that
 * means "many people are affected" so the two cannot drift apart silently.
 */
export const APPLICATION_ERROR_RATE_LIMIT_SUSTAINED_PER_SECOND =
  APPLICATION_ERROR_RATE_LIMIT_MAX / APPLICATION_ERROR_RATE_LIMIT_WINDOW_SECONDS;

export type ApplicationErrorRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * The bucket label for one request.
 *
 * `getTrustedClientIp` — NOT `resolveClientIp` — and the choice is the one the
 * two predicates' own documentation asks a caller to make explicitly:
 *
 *  - `resolveClientIp` is an ATTRIBUTION label. It reads `cf-connecting-ip` with
 *    no corroboration, so a caller composing its own request chooses its own
 *    bucket. For a limiter that is the whole ballgame — a caller that can vary
 *    its key at will can mint itself an unlimited number of empty budgets, and
 *    the limit binds nobody.
 *  - `getTrustedClientIp` accepts `cf-connecting-ip` only alongside `cf-ray`,
 *    and otherwise uses the transport peer, which is observed off the connection
 *    rather than taken from the request. That is the same rule the per-IP
 *    limiter on `/api/v1/block-tokens` already uses, so this endpoint does not
 *    introduce a second opinion about what a client address is.
 *
 * THE TRADE THIS INHERITS, stated because the shared predicate's own docs warn
 * that it is different on a COUNTING surface: traffic that did not transit the
 * edge is attributed to the transport peer, so all such traffic shares ONE
 * bucket. Behind the production edge the reports this endpoint exists to collect
 * are browser requests that DID transit it, so they carry `cf-ray` and bucket
 * per real client — the collapse applies to the residue (direct-to-origin and
 * local development), not to the signal. That residue sharing a bucket is also
 * the conservative direction here: it is the one population whose declared
 * address cannot be corroborated at all.
 *
 * 🔴 If the edge headers ever stop reaching this app, EVERY request collapses
 * into the peer's single bucket and reports are dropped wholesale once it fills.
 * That failure is loud rather than silent — the endpoint's accepted volume falls
 * to the ceiling and stays pinned there — but it is the thing to check first if
 * this endpoint ever appears to have gone quiet.
 */
function rateLimitSubject(req: NextApiRequest): string {
  return getTrustedClientIp(req) ?? UNRESOLVED_CLIENT_IP;
}

export async function checkApplicationErrorRateLimit(
  req: NextApiRequest
): Promise<ApplicationErrorRateLimitResult> {
  const subject = rateLimitSubject(req);
  const rateKey = `${REDIS_SYS_KEYS.CLIENT_ERROR.RATE_LIMIT}:ip:${subject}` as const;

  let count: number;
  try {
    // `SET NX EX` + `INCR` in one MULTI: the key is created WITH its TTL, so a
    // window can never be opened that has no expiry (the shape every sibling
    // limiter here uses).
    const multiResult = await sysRedis
      .multi()
      .set(rateKey, '0', { NX: true, EX: APPLICATION_ERROR_RATE_LIMIT_WINDOW_SECONDS })
      .incr(rateKey)
      .exec();
    count = Number(multiResult?.[1]);
  } catch {
    console.warn('[application-error] rate limiter threw; failing open');
    return { allowed: true };
  }

  if (!Number.isFinite(count)) {
    console.warn('[application-error] rate-limit counter malformed; failing open');
    return { allowed: true };
  }

  // Self-heal a TTL-less key. Re-arm ONLY when the TTL is actually missing, so a
  // live window is never extended — an unconditional `expire` here would let a
  // steady stream of requests hold one window open forever.
  if (count > 1) {
    const ttl = await sysRedis.ttl(rateKey).catch(() => -1);
    if (ttl < 0)
      await sysRedis
        .expire(rateKey, APPLICATION_ERROR_RATE_LIMIT_WINDOW_SECONDS)
        // Best-effort: a failed re-arm leaves the window as it was, which the
        // next request retries. Swallowed so it cannot turn into a 5xx.
        .catch(() => undefined);
  }

  if (count > APPLICATION_ERROR_RATE_LIMIT_MAX) {
    const ttl = await sysRedis
      .ttl(rateKey)
      .catch(() => APPLICATION_ERROR_RATE_LIMIT_WINDOW_SECONDS);
    const retryAfterSeconds = ttl > 0 ? ttl : APPLICATION_ERROR_RATE_LIMIT_WINDOW_SECONDS;
    return { allowed: false, retryAfterSeconds };
  }

  return { allowed: true };
}
