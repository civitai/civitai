import { sysRedis, REDIS_SYS_KEYS, withSysReadDeadline } from '~/server/redis/client';

/**
 * The bundle-submit rate limit, shared by both submit routes (the CLI's token route and the session
 * route): decode + ZIP extract + manifest validation of up to ~72 MiB is heavy, so the window is tight.
 */
export const SUBMIT_RATE_LIMIT = { max: 10, windowSeconds: 60 } as const;

export type SubmitRateDecision =
  | { ok: true }
  /** The limiter could not be read: refuse (503), never let the submit through un-limited. */
  | { ok: false; reason: 'unavailable' | 'malformed' }
  | { ok: false; reason: 'limited'; retryAfterSeconds: number };

/**
 * Counts one submit against `subject` (e.g. `key:<apiKeyId>`, `user:<id>`).
 *
 * `SET NX EX` + `INCR` in one MULTI: the key is always created with its TTL, so a crash between INCR
 * and EXPIRE cannot strand a TTL-less counter. Fails CLOSED: a throw, a deadline-bounded hang (#28: a
 * silent half-open parks the MULTI until TCP keepalive) or a non-finite count (`NaN > max` is false)
 * is a refusal, not a pass.
 */
export async function takeSubmitSlot(subject: string): Promise<SubmitRateDecision> {
  const rateKey = `${REDIS_SYS_KEYS.BLOCKS.SUBMIT_RATE_LIMIT}:${subject}` as const;
  let count: number;
  try {
    const multiResult = await withSysReadDeadline(
      sysRedis
        .multi()
        .set(rateKey, '0', { NX: true, EX: SUBMIT_RATE_LIMIT.windowSeconds })
        .incr(rateKey)
        .exec()
    );
    count = Number(multiResult?.[1]);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!Number.isFinite(count)) return { ok: false, reason: 'malformed' };
  if (count <= SUBMIT_RATE_LIMIT.max) return { ok: true };
  // Bound the 429-path TTL read (#28) too; on a deadline/throw fall back to the full window.
  const retryAfterSeconds = await withSysReadDeadline(sysRedis.ttl(rateKey)).catch(
    () => SUBMIT_RATE_LIMIT.windowSeconds
  );
  return { ok: false, reason: 'limited', retryAfterSeconds };
}
