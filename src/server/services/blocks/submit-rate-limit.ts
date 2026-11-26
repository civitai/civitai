import {
  redis,
  REDIS_KEYS,
  sysRedis,
  REDIS_SYS_KEYS,
  withSysReadDeadline,
} from '~/server/redis/client';
import type { NextApiResponse } from 'next';
import { appRateLimitMeta, sendAppRateLimited } from '~/server/utils/app-rate-limit';
import { boundedClusterCall, takeClusterWindowCount } from '~/server/utils/cluster-window-count';
import { resolveUserAppLimit } from '~/server/services/blocks/user-app-caps.service';
import type { AppUsageLimitId } from '~/shared/constants/app-usage-limits';
import { getUsageLimitDef } from '~/shared/constants/usage-limits';
import type { SessionUser } from '~/types/session';

/** A registry entry's code-default limit and its rolling window. */
function codeDefault(id: AppUsageLimitId): RateLimit {
  const def = getUsageLimitDef(id);
  if (def.window.type !== 'rolling') throw new Error(`${id} is not a rolling window`);
  return { max: def.base, windowSeconds: def.window.seconds };
}

/**
 * The bundle-submit rate limit, shared by both submit routes (the CLI's token route and the session
 * route): decode + ZIP extract + manifest validation of up to ~72 MiB is heavy, so the window is tight.
 */
export const SUBMIT_RATE_LIMIT_ID = 'apps.version-submits';
/** The code default; the enforced limit is the user's resolved `apps.version-submits`. */
export const SUBMIT_RATE_LIMIT = codeDefault(SUBMIT_RATE_LIMIT_ID);

/**
 * Pushes recorded for review: per slug on the git-push webhook, per user on the web manifest editor.
 * Each recorded push supersedes the previous pending request and can start a review build, so this
 * bounds build and moderator-alert churn rather than CPU.
 */
export const PUSH_REVIEW_RATE_LIMIT_ID = 'apps.push-review';
/** The code default; the enforced limit is the resolved `apps.push-review`. */
export const PUSH_REVIEW_RATE_LIMIT = codeDefault(PUSH_REVIEW_RATE_LIMIT_ID);

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
  /** `used`: this window's count, this refused submit included; `limit`: the limit it passed. */
  | { ok: false; reason: 'limited'; retryAfterSeconds: number; used: number; limit: number };

/**
 * Counts one submit against `subject` (e.g. `key:<apiKeyId>`, `user:<id>`).
 *
 * `SET NX EX` + `INCR` in one MULTI: the key is always created with its TTL, so a crash between INCR
 * and EXPIRE cannot strand a TTL-less counter. Fails CLOSED: a throw, a deadline-bounded hang (#28: a
 * silent half-open parks the MULTI until TCP keepalive) or a non-finite count (`NaN > max` is false)
 * is a refusal, not a pass.
 */
export async function takeSubmitSlot(
  subject: string,
  /** The submitting user, whose resolved `apps.version-submits` is the limit (both subjects). */
  user: SessionUser | number | null
): Promise<SubmitRateDecision> {
  const max = await resolveUserAppLimit(SUBMIT_RATE_LIMIT_ID, user);
  return takeRateSlot('submit', subject, { ...SUBMIT_RATE_LIMIT, max });
}

/**
 * Counts one push recorded for review against `subject` (`slug:<slug>`, `user:<id>`) and refuses
 * only a spent window. Unlike the submit limit this FAILS OPEN on a limiter outage: the push it
 * gates records work the author already committed, and refusing would drop it from review, while
 * the limit exists to bound build and alert churn rather than server load.
 */
export async function takePushReviewSlot(
  subject: string,
  /** The pushing user where there is one (the manifest editor); null for a slug's webhook push. */
  user: SessionUser | number | null
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const max = await resolveUserAppLimit(PUSH_REVIEW_RATE_LIMIT_ID, user);
  const decision = await takeRateSlot('push', subject, { ...PUSH_REVIEW_RATE_LIMIT, max });
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
  return { ok: false, reason: 'limited', retryAfterSeconds, used: count, limit: limit.max };
}

/**
 * The 429 both submit routes answer a spent submit window with: the house body and meta, and the
 * fields these routes always sent beside it (`retryAfterSeconds`, `limit`, `windowSeconds`).
 */
export function sendSubmitRateLimited(
  res: NextApiResponse,
  slot: { retryAfterSeconds: number; used: number; limit: number }
): void {
  const { windowSeconds } = SUBMIT_RATE_LIMIT;
  const max = slot.limit;
  const meta = appRateLimitMeta(SUBMIT_RATE_LIMIT_ID, slot.retryAfterSeconds, {
    limit: max,
    used: slot.used,
    windowSeconds,
    resetAt: new Date(Date.now() + Math.max(slot.retryAfterSeconds, 1) * 1000),
  });
  sendAppRateLimited(res, meta, 'Rate limit exceeded', {
    retryAfterSeconds: slot.retryAfterSeconds,
    limit: max,
    windowSeconds,
  });
}
