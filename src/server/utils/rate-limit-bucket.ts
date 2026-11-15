import { TRPCError } from '@trpc/server';
import { pack } from 'msgpackr';
import type { NextApiRequest } from 'next';
import { isDev, isPreview, isTest } from '~/env/other';
import { env } from '~/env/server';
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
// RULE: a router belongs here if ANY of its procedures charges or pays Buzz (or takes payment) —
// classify a new router by that, not by which of its procedures happen to be rate-limited today.
export const FAIL_CLOSED_RATE_LIMIT_SCOPES: readonly string[] = [
  'buzz',
  'nowPayments',
  'generation',
  'orchestrator',
  // run / start / advance / testStart quote and submit Buzz-paid orchestrator workflows.
  'remixApp',
  'training',
];

/** Routers whose rate-limited procedures use the per-process fallback count. See above. */
export const RATE_LIMIT_FALLBACK_SCOPES: readonly string[] = [
  'appCollaborators',
  'appFeedback',
  // getWakeSeed / deleteMine: a user's own sleeping apps; nothing charges or pays Buzz.
  'appHibernation',
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
  // claim pays out, but through an idempotent ledger key: a re-admitted claim cannot pay twice.
  'prize',
  'reaction',
  'report',
  'resourceLoad',
  'semanticArticleSearch',
  'semanticChallengeSearch',
  'semanticComicSearch',
  'semanticImageSearch',
  'semanticModel3DSearch',
  'semanticStorylineSearch',
  'storyline',
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
 * Per bucket, and never discarded on a successful read. A bucket whose reads alternate between
 * answered and failed (intermittent timeouts) holds attempts the store never saw, so an answered
 * read MERGES the bucket's local attempts into the stored ones (mergeAttempts) — the write that
 * follows carries them into the store — and the local entry then mirrors the merged history, so the
 * bucket's next failed read still sees every attempt this process knows of. Dropping the local
 * count on an answered read instead would admit about limit / (share of answered reads). Never the
 * whole map either: in a partial outage (one shard down) another bucket's answered read must not
 * touch a bucket whose reads keep failing.
 *
 * Bounded memory, two ways: an entry expires one longest window after the bucket's last FAILED-read
 * attempt — an answered read refreshes the mirror but not its expiry, so a bucket whose reads have
 * been answered for a whole window stops being held. Expired entries are swept at most every
 * LOCAL_SWEEP_INTERVAL_MS, from both the failed- and the answered-read path (a read needs no expiry
 * check, since the window evaluation ignores attempts outside it). Past LOCAL_BUCKETS_MAX buckets
 * the least recently written is dropped, so an outage under a flood of distinct callers costs
 * bounded memory.
 */
const LOCAL_BUCKETS_MAX = 50_000;
const LOCAL_SWEEP_INTERVAL_MS = 60_000;
type LocalBucket = { attempts: number[]; expiresAt: number };
const localAttempts = new Map<string, LocalBucket>();
let localBucketsMax = LOCAL_BUCKETS_MAX;
let lastLocalSweepAt = 0;
const localKeyOf = (bucket: RateLimitBucket) => `${bucket.cacheKey}|${bucket.hashKey}`;

function sweepExpiredLocalBuckets(now: number) {
  if (now - lastLocalSweepAt < LOCAL_SWEEP_INTERVAL_MS) return;
  lastLocalSweepAt = now;
  for (const [key, entry] of localAttempts) if (entry.expiresAt <= now) localAttempts.delete(key);
}

/**
 * The union of two views of ONE bucket's history (attempt timestamps, epoch ms): each timestamp
 * appears as often as in whichever view holds it more often, so an attempt present in both — a
 * local attempt that already reached the store, or a mirrored one — counts once. (Two distinct
 * attempts in the same millisecond, one only in each view, also count once: a negligible
 * under-count, against double-counting every mirrored attempt.)
 */
export function mergeAttempts(a: readonly number[], b: readonly number[]) {
  const countIn = (xs: readonly number[]) => {
    const counts = new Map<number, number>();
    for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
    return counts;
  };
  const inA = countIn(a);
  const merged = [...a];
  for (const [x, n] of countIn(b)) for (let i = inA.get(x) ?? 0; i < n; i++) merged.push(x);
  return merged.sort((x, y) => x - y);
}

/**
 * After an answered read: the local entry (if the bucket has one that has not expired) now mirrors
 * the merged history written to the store, keeping its expiry. Merged with the entry as it is NOW,
 * so a failed-read attempt recorded concurrently since our read is kept.
 */
function mirrorLocalAttempts(bucket: RateLimitBucket, attempts: number[], now: number) {
  const key = localKeyOf(bucket);
  const entry = localAttempts.get(key);
  if (!entry) return;
  if (entry.expiresAt <= now) {
    localAttempts.delete(key);
    return;
  }
  entry.attempts = mergeAttempts(attempts, entry.attempts);
}

function recordLocalAttempt(bucket: RateLimitBucket, at: number, longestPeriodSec: number) {
  const key = localKeyOf(bucket);
  const windowMs = longestPeriodSec * 1000;
  const kept = (localAttempts.get(key)?.attempts ?? []).filter((x) => x > at - windowMs);
  kept.push(at);
  // Re-insert so Map order tracks recency; evict the least recently written past the cap.
  localAttempts.delete(key);
  localAttempts.set(key, { attempts: kept, expiresAt: at + windowMs });
  sweepExpiredLocalBuckets(at);
  while (localAttempts.size > localBucketsMax) {
    const oldest = localAttempts.keys().next().value;
    if (oldest === undefined) break;
    localAttempts.delete(oldest);
  }
}

/** Test seam: the number of buckets held locally, and a reset (optionally with a smaller cap). */
export function __localRateLimitBucketCountForTests() {
  return localAttempts.size;
}
export function __resetLocalRateLimitBucketsForTests(opts: { maxBuckets?: number } = {}) {
  localAttempts.clear();
  lastLocalSweepAt = 0;
  localBucketsMax = opts.maxBuckets ?? LOCAL_BUCKETS_MAX;
}

/**
 * The bucket read for a FAIL-CLOSED scope waits this long (instead of the guard's default
 * REDIS_CACHE_READ_DEADLINE_MS) before failing, because there a failed read is a 503 rather than a
 * fallback count: a merely slow read or a short event-loop stall must not refuse a payment. Only a
 * store that stays silent this long — an outage — fails closed. Off, like every guard deadline,
 * when REDIS_CACHE_READ_DEADLINE_MS=0.
 */
export const FAIL_CLOSED_RATE_LIMIT_READ_DEADLINE_MS = 2000;

const failClosedReadDeadlineMs = () =>
  env.REDIS_CACHE_READ_DEADLINE_MS > 0 ? FAIL_CLOSED_RATE_LIMIT_READ_DEADLINE_MS : 0;

/** The bucket's attempts, from the store when it answers, else this process's local count. */
async function readAttemptsOrLocal(
  bucket: RateLimitBucket,
  failClosed: boolean
): Promise<{ attempts: number[]; degraded: boolean }> {
  try {
    const stored = await clusterCacheGuard.call(
      'rate-limit-bucket.read',
      () => redis.packed.hGet<number[]>(bucket.cacheKey, bucket.hashKey),
      {
        logExtra: { cacheKey: bucket.cacheKey },
        ...(failClosed ? { deadlineMs: failClosedReadDeadlineMs() } : {}),
      }
    );
    // The store answers for this bucket: merge in the attempts this process counted while its
    // reads failed, which the store never saw (see localAttempts). The write carries them.
    sweepExpiredLocalBuckets(Date.now());
    const local = localAttempts.get(localKeyOf(bucket));
    return {
      attempts: local ? mergeAttempts(stored ?? [], local.attempts) : stored ?? [],
      degraded: false,
    };
  } catch {
    return {
      attempts: [...(localAttempts.get(localKeyOf(bucket))?.attempts ?? [])],
      degraded: true,
    };
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
  const failClosed = isFailClosedRateLimitScope(scope);
  const { attempts, degraded } = await readAttemptsOrLocal(bucket, failClosed);
  if (degraded && failClosed) {
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
    mirrorLocalAttempts(bucket, updatedAttempts, Date.now());
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
