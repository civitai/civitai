import {
  redis,
  REDIS_KEYS,
  sysRedis,
  REDIS_SYS_KEYS,
  withSysReadDeadline,
} from '~/server/redis/client';
import { boundedClusterCall, takeClusterWindowCount } from '~/server/utils/cluster-window-count';

/**
 * The bundle-submit rate limit, shared by both submit routes (the CLI's token route and the session
 * route): decode + ZIP extract + manifest validation of up to ~72 MiB is heavy, so the window is tight.
 */
export const SUBMIT_RATE_LIMIT = { max: 10, windowSeconds: 60 } as const;

/**
 * Pushes recorded for review: per slug on the git-push webhook, per user on the web manifest editor.
 * Each recorded push supersedes the previous pending request and can start a review build, so this
 * bounds build and moderator-alert churn rather than CPU.
 */
export const PUSH_REVIEW_RATE_LIMIT = { max: 20, windowSeconds: 60 * 60 } as const;

export type RateLimit = { readonly max: number; readonly windowSeconds: number };

const RATE_KEYS = {
  submit: REDIS_SYS_KEYS.BLOCKS.SUBMIT_RATE_LIMIT,
  push: REDIS_KEYS.BLOCKS.PUSH_REVIEW_RATE_LIMIT,
} as const;

/**
 * One window's count after this take, and its TTL on the 429 path, from the store the family
 * lives in.
 */
function rateStore(family: keyof typeof RATE_KEYS, subject: string, windowSeconds: number) {
  if (family === 'push') {
    const key = `${RATE_KEYS.push}:${subject}` as const;
    return {
      take: (): Promise<number> => takeClusterWindowCount('takePushReviewSlot', key, windowSeconds),
      ttl: (): Promise<number> => boundedClusterCall('takePushReviewSlot', () => redis.ttl(key)),
    };
  }
  const key = `${RATE_KEYS.submit}:${subject}` as const;
  // Submit limits stay on sysRedis: durable across eviction, so a lost window cannot admit a burst
  // of submits.
  return {
    take: async (): Promise<number> => {
      const reply = await withSysReadDeadline(
        sysRedis.multi().set(key, '0', { NX: true, EX: windowSeconds }).incr(key).exec()
      );
      return Number((reply as unknown[] | null)?.[1]);
    },
    ttl: (): Promise<number> => withSysReadDeadline(sysRedis.ttl(key)),
  };
}

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
  return takeRateSlot('submit', subject, SUBMIT_RATE_LIMIT);
}

/**
 * Counts one push recorded for review against `subject` (`slug:<slug>`, `user:<id>`) and refuses
 * only a spent window. Unlike the submit limit this FAILS OPEN on a limiter outage: the push it
 * gates records work the author already committed, and refusing would drop it from review, while
 * the limit exists to bound build and alert churn rather than server load.
 */
export async function takePushReviewSlot(
  subject: string
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const decision = await takeRateSlot('push', subject, PUSH_REVIEW_RATE_LIMIT);
  if (!decision.ok && decision.reason === 'limited') {
    return { ok: false, retryAfterSeconds: decision.retryAfterSeconds };
  }
  return { ok: true };
}

async function takeRateSlot(
  family: keyof typeof RATE_KEYS,
  subject: string,
  limit: RateLimit
): Promise<SubmitRateDecision> {
  const store = rateStore(family, subject, limit.windowSeconds);
  let count: number;
  try {
    count = await store.take();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!Number.isFinite(count)) return { ok: false, reason: 'malformed' };
  if (count <= limit.max) return { ok: true };
  // Bound the 429-path TTL read (#28) too; on a deadline/throw fall back to the full window.
  const retryAfterSeconds = await store.ttl().catch(() => limit.windowSeconds);
  return { ok: false, reason: 'limited', retryAfterSeconds };
}
