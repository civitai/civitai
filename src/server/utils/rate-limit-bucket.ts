import { TRPCError } from '@trpc/server';
import { pack } from 'msgpackr';
import type { NextApiRequest } from 'next';
import { isDev, isPreview, isTest } from '~/env/other';
import { CacheTTL } from '~/server/common/constants';
import { hSetWithTTL } from '~/server/redis/atomic';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { resolveClientIp } from '~/server/utils/client-ip';
import { throwRateLimited } from '~/server/utils/rate-limit-error';
import {
  bindingRefusal,
  evaluateRateLimitWindow,
  rateLimitMetaForRefusal,
  selectRateLimitRules,
  type RateLimit,
  type RuleUsage,
} from '~/server/utils/rate-limit-window';
import type { SessionUser } from '~/types/session';

/**
 * Where the tRPC `rateLimit()` middleware keeps a caller's attempts for `keyName` (a tRPC path
 * with `:` for `.`, or a `sharedKey`): one hash per key, one field per caller.
 *
 * Anonymous callers bucket by client IP, authenticated ones by user id. The IP comes from the
 * SHARED predicate in `~/server/utils/client-ip` rather than the general-purpose `ctx.ip`, so this
 * limiter and the public REST limiter derive the bucket the same way — see that module's doc for
 * which predicate suits which surface.
 *
 * NAMESPACE THE FIELD. User ids and addresses are two different namespaces and both are written
 * into one hash, where equal strings are one bucket. The prefix makes the two key spaces disjoint
 * by construction rather than by whichever values happen not to overlap. Same shape as the public
 * REST limiter (`~/server/utils/public-api-rate-limit`), deliberately.
 * `!= null` and not a truthiness test, or a user id of 0 would silently route to the IP branch.
 * Pinned by the id-0 case in `src/server/__tests__/middleware.trpc.rate-limit-key.test.ts`.
 */
export function rateLimitBucket(
  keyName: string,
  user: Pick<SessionUser, 'id'> | undefined,
  req: NextApiRequest
) {
  const cacheKey = `${REDIS_KEYS.TRPC.LIMIT.BASE}:${keyName}` as const;
  const hashKey = user?.id != null ? `user:${user.id}` : `ip:${resolveClientIp(req)}`;
  return { cacheKey, hashKey };
}

/** The recorded attempts (epoch ms) in a bucket. A store failure throws, as the limiter's read does. */
export async function readRateLimitAttempts(bucket: ReturnType<typeof rateLimitBucket>) {
  return (await redis.packed.hGet<number[]>(bucket.cacheKey, bucket.hashKey)) ?? [];
}

/**
 * The caller's usage of each rule that applies to them, read from the bucket `rateLimit()` writes
 * for `sharedKey`. Never records an attempt. Only ever the caller's own bucket: `user` and `req`
 * are the request's, never an input.
 */
export async function peekRateLimit({
  rules,
  sharedKey,
  user,
  req,
  now = Date.now(),
}: {
  rules: RateLimit[];
  sharedKey: string;
  user: SessionUser | undefined;
  req: NextApiRequest;
  now?: number;
}): Promise<RuleUsage[]> {
  const applicable = selectRateLimitRules(rules, user);
  if (applicable.length === 0) return [];
  const attempts = await readRateLimitAttempts(rateLimitBucket(sharedKey, user, req));
  return evaluateRateLimitWindow(applicable, attempts, now);
}

/**
 * One attempt against `keyName`'s rules for this caller, counted as the tRPC `rateLimit()` middleware
 * counts it, so a REST endpoint can draw from a procedure's bucket (`keyName` = its path with `:`).
 * Throws TOO_MANY_REQUESTS past a limit; otherwise returns the write that records the attempt.
 * Moderators and non-prod envs are exempt, as in the middleware.
 */
export async function claimRateLimitAttempt({
  rules,
  keyName,
  user,
  req,
}: {
  rules: RateLimit[];
  keyName: string;
  user: SessionUser | undefined;
  req: NextApiRequest;
}): Promise<() => Promise<void>> {
  // Preview shares a dev DB with a few CI smoke accounts; daily quotas exhaust across PR runs (civitai#2592).
  if (user?.isModerator || isDev || isTest || isPreview) return async () => undefined;

  const validLimits = selectRateLimitRules(rules, user);
  const bucket = rateLimitBucket(keyName, user, req);
  const { cacheKey, hashKey } = bucket;
  const attempts = await readRateLimitAttempts(bucket);

  const now = Date.now();
  const usages = evaluateRateLimitWindow(validLimits, attempts, now);
  const refusal = bindingRefusal(usages);
  if (refusal) {
    const message = refusal.rule.errorMessage ?? `You're doing that too much...`;
    const meta = rateLimitMetaForRefusal(usages, now);
    if (meta) throwRateLimited(meta, message);
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message });
  }

  return async () => {
    attempts.push(Date.now());
    const longestPeriod = Math.max(...validLimits.map((x) => x.period!));
    const updatedAttempts = attempts.filter((x) => x > Date.now() - longestPeriod * 1000);
    // Fail-open: a sysRedis failover would otherwise 500 every rate-limited call; the window
    // under-counts until the next good write. A sustained rate-limit-write-degraded spike means
    // limits are effectively off.
    try {
      await hSetWithTTL(redis, cacheKey, hashKey, pack(updatedAttempts), CacheTTL.day * 1000);
    } catch (error) {
      logSysRedisFailOpen(
        'rate-limit-write-degraded',
        'rate-limit-bucket.claimRateLimitAttempt',
        error,
        {
          cacheKey,
          hashKey,
        }
      );
    }
  };
}
