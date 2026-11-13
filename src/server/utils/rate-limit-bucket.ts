import { TRPCError } from '@trpc/server';
import { pack } from 'msgpackr';
import type { NextApiRequest } from 'next';
import { isDev, isPreview, isTest } from '~/env/other';
import { CacheTTL } from '~/server/common/constants';
import { hSetWithTTL } from '~/server/redis/atomic';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import {
  ClusterCacheUnavailableError,
  clusterCacheGuard,
} from '~/server/redis/cluster-cache-guard';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { noteRateLimitUsage } from '~/server/trpc/rate-limit-headers';
import { markActiveLimit } from '~/server/utils/active-rate-limits';
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
import { resolveUsageLimitRules } from '~/server/services/usage-limit-config.service';
import { isUsageLimitRef, type UsageLimitRef } from '~/shared/constants/usage-limits';
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

type RateLimitBucket = ReturnType<typeof rateLimitBucket>;

/**
 * 🔴 Router keys whose rate-limited procedures FAIL CLOSED when the store is unreadable: buzz,
 * payments and generation/orchestrator (training runs and auto-label are orchestrator jobs paid in
 * buzz). There the limiter refuses with a 503 rather than admit on a per-process count the store
 * cannot confirm — an operator decision: money paths do not degrade open, even partly.
 *
 * Every other rate-limiting router is listed in RATE_LIMIT_FALLBACK_SCOPES and uses the
 * per-process fallback below. The two lists are a LEDGER: a test fails until every router that
 * rate-limits a procedure is in exactly one of them, so a new money router cannot silently inherit
 * the fallback. A new procedure in a fail-closed router is fail-closed with no further step.
 */
export const FAIL_CLOSED_RATE_LIMIT_SCOPES: readonly string[] = [
  'buzz',
  'nowPayments',
  'generation',
  'orchestrator',
  'training',
];

/** Routers whose rate-limited procedures use the per-process fallback count. See above. */
export const RATE_LIMIT_FALLBACK_SCOPES: readonly string[] = [
  'appCollaborators',
  'appFeedback',
  'appListings',
  'appStorage',
  'article',
  'blockImageUpload',
  'blocks',
  'commentv3',
  'content',
  'cosmetic',
  'creatorServiceDealFile',
  'crucible',
  'event',
  'feedback',
  'hatTurf',
  'hiddenPreferences',
  'model',
  'placement',
  'platformFeedback',
  'post',
  'postIntent',
  'prize',
  'reaction',
  'remixApp',
  'report',
  'resourceLoad',
  'semanticArticleSearch',
  'semanticImageSearch',
  'user',
];

const failClosedScopes = new Set(FAIL_CLOSED_RATE_LIMIT_SCOPES);

/** The scope's router key — before the first `.` (tRPC path) or `:` (bucket key) — is fail-closed. */
export function isFailClosedRateLimitScope(scope: string) {
  return failClosedScopes.has(scope.split(/[.:]/, 1)[0]);
}

/**
 * Attempts counted in THIS process while the store (the cluster cache) is unavailable — a read that
 * fails, times out, or is short-circuited by the cluster-cache breaker. Abuse prevention must not
 * switch off with the store, and failing every rate-limited call would turn a cache outage into an
 * outage of every procedure that has a limit, so the limiter keeps counting here instead: each
 * process enforces the full rule on the attempts it saw, a finite limit (at most the rule × the
 * number of processes) rather than none.
 *
 * Not for FAIL_CLOSED_RATE_LIMIT_SCOPES, which refuse instead (see above).
 *
 * Only filled while degraded, and discarded in effect once the store answers again (the store's own
 * history is authoritative then). Bounded: past LOCAL_BUCKETS_MAX buckets the oldest is dropped, so
 * an outage under a flood of distinct callers costs bounded memory.
 */
const LOCAL_BUCKETS_MAX = 50_000;
const localAttempts = new Map<string, number[]>();
const localKeyOf = (bucket: RateLimitBucket) => `${bucket.cacheKey}|${bucket.hashKey}`;

function recordLocalAttempt(bucket: RateLimitBucket, at: number, longestPeriodSec: number) {
  const key = localKeyOf(bucket);
  const kept = (localAttempts.get(key) ?? []).filter((x) => x > at - longestPeriodSec * 1000);
  kept.push(at);
  // Re-insert so Map order tracks recency; evict the least recently written past the cap.
  localAttempts.delete(key);
  localAttempts.set(key, kept);
  if (localAttempts.size > LOCAL_BUCKETS_MAX) {
    const oldest = localAttempts.keys().next().value;
    if (oldest !== undefined) localAttempts.delete(oldest);
  }
}

/** The bucket's attempts, from the store when it answers, else this process's local count. */
async function readAttemptsOrLocal(
  bucket: RateLimitBucket
): Promise<{ attempts: number[]; degraded: boolean }> {
  try {
    const stored = await clusterCacheGuard.call(
      'rate-limit-bucket.read',
      () => redis.packed.hGet<number[]>(bucket.cacheKey, bucket.hashKey),
      { logExtra: { cacheKey: bucket.cacheKey } }
    );
    return { attempts: stored ?? [], degraded: false };
  } catch {
    return { attempts: [...(localAttempts.get(localKeyOf(bucket)) ?? [])], degraded: true };
  }
}

/**
 * The recorded attempts (epoch ms) in a bucket, for REPORTING (`peekRateLimit`). A store failure
 * throws — bounded by the cluster-cache guard, with the store's own error when it gave one.
 *
 * Deliberately NOT the limiter's per-process fallback: that local count exists so enforcement never
 * switches off, and it starts empty on every process, so as a usage report it would tell a caller
 * they have their whole quota left when the store says otherwise. A report with no data errors.
 */
export async function readRateLimitAttempts(bucket: RateLimitBucket) {
  try {
    const stored = await clusterCacheGuard.call(
      'rate-limit-bucket.peek',
      () => redis.packed.hGet<number[]>(bucket.cacheKey, bucket.hashKey),
      { logExtra: { cacheKey: bucket.cacheKey } }
    );
    return stored ?? [];
  } catch (err) {
    throw err instanceof ClusterCacheUnavailableError && err.cause ? err.cause : err;
  }
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
 * One attempt against `keyName`'s rules for this caller: the body of the tRPC `rateLimit()`
 * middleware, and how a REST endpoint draws from a procedure's bucket (`keyName` = its path with
 * `:`). `rules` is a fixed list or `usageLimits(...ids)`, resolved per call from the usage-limit
 * config. Throws TOO_MANY_REQUESTS past a limit; otherwise returns the write that records the
 * attempt. Moderators and non-prod envs are exempt.
 */
export async function claimRateLimitAttempt({
  rules,
  keyName,
  scope = keyName,
  user,
  req,
}: {
  rules: RateLimit[] | UsageLimitRef;
  keyName: string;
  /** The procedure this attempt is for — its tRPC path (`router.procedure`) or `router:...`. Decides
   * fail-closed vs fallback (see FAIL_CLOSED_RATE_LIMIT_SCOPES). Defaults to `keyName`; the tRPC
   * middleware passes the path, so a `sharedKey` can never move a procedure out of its router. */
  scope?: string;
  user: SessionUser | undefined;
  req: NextApiRequest;
}): Promise<() => Promise<void>> {
  // Preview shares a dev DB with a few CI smoke accounts; daily quotas exhaust across PR runs (civitai#2592).
  if (user?.isModerator || isDev || isTest || isPreview) return async () => undefined;

  const validLimits = isUsageLimitRef(rules)
    ? await resolveUsageLimitRules(rules.usageLimitIds, user)
    : selectRateLimitRules(rules, user);
  // Nothing applies (every entry disabled or out of scope): count nothing, and keep the history.
  if (validLimits.length === 0) return async () => undefined;
  const bucket = rateLimitBucket(keyName, user, req);
  const { cacheKey, hashKey } = bucket;
  const { attempts, degraded } = await readAttemptsOrLocal(bucket);
  if (degraded && isFailClosedRateLimitScope(scope)) {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'This is temporarily unavailable. Please try again in a moment.',
    });
  }

  const now = Date.now();
  const usages = evaluateRateLimitWindow(validLimits, attempts, now);
  const refusal = bindingRefusal(usages);
  if (refusal) {
    const message = refusal.rule.errorMessage ?? `You're doing that too much...`;
    // A gate (limit 0) never frees a slot, so no header can describe it.
    if (refusal.rule.kind === 'product' && refusal.nextAt !== null) noteRateLimitUsage(req, usages);
    // The account banner lives in the same store; while it is unavailable, skip it rather than
    // hold the refusal on a write that cannot land.
    else if (user && refusal.nextAt !== null && !degraded)
      await markActiveLimit({ userId: user.id, keyName, retryAt: refusal.nextAt, now });
    const meta = rateLimitMetaForRefusal(usages, now);
    if (meta) throwRateLimited(meta, message);
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message });
  }

  return async () => {
    attempts.push(Date.now());
    noteRateLimitUsage(req, evaluateRateLimitWindow(validLimits, attempts, Date.now()));
    const longestPeriod = Math.max(...validLimits.map((x) => x.period!));
    if (degraded) {
      recordLocalAttempt(bucket, attempts[attempts.length - 1], longestPeriod);
      return;
    }
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
