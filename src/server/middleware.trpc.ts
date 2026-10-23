import { TRPCError } from '@trpc/server';
import { pack } from 'msgpackr';
import superjson from 'superjson';
import { isDev, isPreview, isProd, isTest } from '~/env/other';
import { purgeCache } from '~/server/cloudflare/client';
import { CacheTTL } from '~/server/common/constants';
import { logToAxiom } from '~/server/logging/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { hSetWithTTL, sAddCappedWithExpireGe, sAddWithExpireGe } from '~/server/redis/atomic';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import type { Context } from '~/server/createContext';
import type { UserPreferencesInput } from '~/server/schema/base.schema';
import { ITEM_HOLDER_BUSY_MESSAGE } from '~/server/services/item-holder-lock';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { middleware } from '~/server/trpc';
import { resolveClientIp } from '~/server/utils/client-ip';
import { acquireConcurrencySlot, type ConcurrencySlot } from '~/server/utils/concurrency-slots';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import { getRequestBoardDomainColor, getRequestDomainColor } from '~/server/utils/server-domain';
import type { SessionUser } from '~/types/session';
import { withSpan } from '~/server/utils/otel-helpers';
import { hashifyObject, slugit } from '~/utils/string-helpers';
import { booleanString } from '~/utils/zod-helpers';

export const applyUserPreferences = middleware(async ({ input, ctx, next }) => {
  return withSpan('trpc:middleware:applyUserPreferences', async () => {
    const _input = input as UserPreferencesInput | undefined;
    if (_input !== undefined && typeof _input === 'object' && !Array.isArray(_input)) {
      // _input.browsingLevel ??= ctx.browsingLevel;

      // TODO.hiddenPreferences - update this once `disableHidden` comes in with rest of user settings
      const result = booleanString().optional().safeParse(ctx.req.cookies['disableHidden']);
      const disableHidden = result.success ? result.data ?? false : false;

      const { hiddenImages, hiddenTags, hiddenModels, hiddenUsers } = await getAllHiddenForUser({
        userId: ctx.user?.id,
      });

      const tagsToHide = hiddenTags.filter((x) => !disableHidden && x.hidden).map((x) => x.id);

      const imagesToHide = hiddenImages
        .filter((x) => !x.tagId || tagsToHide.findIndex((tagId) => tagId === x.tagId) > -1)
        .map((x) => x.id);

      _input.excludedTagIds = [...(_input.excludedTagIds ?? []), ...tagsToHide];
      _input.excludedImageIds = [...(_input.excludedImageIds ?? []), ...imagesToHide];
      _input.excludedUserIds = [...(_input.excludedUserIds ?? []), ...hiddenUsers.map((x) => x.id)];
      _input.excludedModelIds = [
        ...(_input.excludedModelIds ?? []),
        ...hiddenModels.map((x) => x.id),
      ];
    }

    return next({
      ctx: { user: ctx.user },
    });
  });
});

type CacheItProps<TInput extends object> = {
  key?: string;
  ttl?: number;
  excludeKeys?: (keyof TInput)[];
  // Response dimensions that live on ctx rather than on the input — the `Vary`
  // header's job. A procedure whose output varies on something the input never
  // carries has to declare it here or the key cannot tell two callers apart.
  varyBy?: (ctx: Context) => Record<string, unknown>;
  tags?: (input: TInput) => string[];
};
export function cacheIt<TInput extends object>({
  key,
  ttl,
  excludeKeys,
  varyBy,
  tags,
}: CacheItProps<TInput> = {}) {
  ttl ??= 60 * 3;

  return middleware(async ({ input, ctx, next, path }) => {
    const _input = input as TInput;
    const cacheKeyObj: Record<string, any> = {};
    if (_input) {
      for (const [key, value] of Object.entries(_input)) {
        if (excludeKeys?.includes(key as keyof TInput)) continue;
        if (Array.isArray(value)) cacheKeyObj[key] = [...new Set(value)].sort();
        else if (value) cacheKeyObj[key] = value;
      }
    }
    for (const [varyKey, varyValue] of Object.entries(varyBy?.(ctx) ?? {})) {
      if (_input && Object.prototype.hasOwnProperty.call(_input, varyKey))
        throw new Error(`cacheIt: varyBy key "${varyKey}" collides with an input key on ${path}`);
      cacheKeyObj[varyKey] = varyValue;
    }
    const hash = withSpan('trpc:middleware:cacheIt:hash', () => hashifyObject(cacheKeyObj));
    const cacheKey = `${REDIS_KEYS.TRPC.BASE}:${key ?? path.replace('.', ':')}:${hash}` as const;
    const cached = await redis.packed.get(cacheKey);
    if (cached) {
      return { ok: true, data: cached, marker: 'fromCache' as any, ctx };
    }

    const result = await next({ ctx });
    if (result.ok && result.data && ctx.cache?.canCache) {
      // Fail-open: the query already succeeded — a Redis blip while WRITING the
      // cache (the value `set` or the tag `sAddWithExpireGe`) must never turn a
      // successful response into a 500 on this shared hot path. On failure we
      // log the degraded write and return the computed result uncached (it
      // simply misses next time). Mirrors rateLimit.recordAttempt's wrapper.
      try {
        const cacheTags = tags?.(_input).map((x) => slugit(x));
        await redis.packed.set(cacheKey, result.data, {
          EX: ttl,
        });

        if (cacheTags) {
          await Promise.all(
            cacheTags.map((tag) => {
              const key = `${REDIS_KEYS.CACHES.TAGGED_CACHE}:${tag}` as const;
              // One atomic EVAL per tag: SADD the member AND floor the set's TTL to
              // `ttl` only when it's below it — replaces the racy `sAdd` + always-on
              // `expire` pair, dropping the separate per-write EXPIRE command while
              // preserving the "tag-set outlives its members" invariant (never
              // shortens a longer-TTL set). See sAddWithExpireGe.
              return sAddWithExpireGe(redis, key, cacheKey, ttl);
            })
          );
        }
      } catch (error) {
        logSysRedisFailOpen('write-degraded', 'middleware.trpc.cacheIt', error, {
          cacheKey,
          path,
        });
      }
    }

    return result;
  });
}

export type RateLimit = {
  limit: number;
  period: number; // seconds
  userReq?: (user: SessionUser) => boolean;
  errorMessage?: string;
};
export type RateLimitOptions = {
  // When true, an attempt is only counted toward the limit after the procedure
  // succeeds. Failed calls (validation errors, server hiccups, etc.) won't burn
  // a slot. Off by default so abuse-prevention limits still count failed tries.
  onlyCountSuccess?: boolean;
  // Override the cache key (defaults to the tRPC path). Use the SAME sharedKey on
  // multiple procedures to make them share one quota — e.g. post.create and
  // post.createWithImages both posting against a single per-user post ceiling.
  sharedKey?: string;
};
export function rateLimit<TInput = any>(
  rateLimits?: RateLimit | RateLimit[],
  condition?: (input: TInput) => boolean,
  options?: RateLimitOptions
) {
  if (!rateLimits) rateLimits = { limit: 10, period: CacheTTL.md };
  if (!Array.isArray(rateLimits)) rateLimits = [rateLimits];

  return middleware(async ({ ctx, input, next, path }) => {
    // Skip if user is a moderator, or in a non-prod env (dev/test/preview).
    // Preview runs on the shared dev DB with a small set of CI smoke accounts, so
    // per-account daily quotas (e.g. the new-post limit) get exhausted across many
    // PR runs and the smoke suite fails deterministically — see civitai#2592.
    if (ctx.user?.isModerator || isDev || isTest || isPreview) return await next();

    // Skip rate limiting if condition is provided and not met
    if (condition && !condition(input as TInput)) {
      return await next();
    }

    // Get valid limits
    const validLimits: RateLimit[] = [];
    for (const rateLimit of rateLimits) {
      const matchedPeriod = validLimits.find((x) => x.period === rateLimit.period);
      if (matchedPeriod?.limit && matchedPeriod.limit > rateLimit.limit) continue;
      if (!rateLimit.userReq || (ctx.user && rateLimit.userReq(ctx.user))) {
        // Replace the existing limit if it exists
        if (matchedPeriod) {
          validLimits.splice(validLimits.indexOf(matchedPeriod), 1, rateLimit);
        } else {
          validLimits.push(rateLimit);
        }
      }
    }

    // Get user's attempts. options.sharedKey lets multiple procedures share one
    // quota; otherwise key on the tRPC path.
    const keyName = options?.sharedKey ?? path.replace('.', ':');
    const cacheKey = `${REDIS_KEYS.TRPC.LIMIT.BASE}:${keyName}` as const;
    // Anonymous callers bucket by client IP, authenticated ones by user id. The
    // IP comes from the SHARED predicate in `~/server/utils/client-ip` rather
    // than the general-purpose `ctx.ip`, so this limiter and the public REST
    // limiter derive the bucket the same way — see that module's doc for which
    // predicate suits which surface.
    //
    // NAMESPACE THE FIELD. User ids and addresses are two different namespaces
    // and both are written into one hash, where equal strings are one bucket.
    // The prefix makes the two key spaces disjoint by construction rather than
    // by whichever values happen not to overlap. Same shape as the public REST
    // limiter (`~/server/utils/public-api-rate-limit`), deliberately.
    // `!= null` and not a truthiness test: it must match the nullish semantics of
    // the `??` this replaced, or a user id of 0 would silently route to the IP
    // branch. Pinned by the id-0 case in
    // `src/server/__tests__/middleware.trpc.rate-limit-key.test.ts`.
    const hashKey = ctx.user?.id != null ? `user:${ctx.user.id}` : `ip:${resolveClientIp(ctx.req)}`;
    const attempts = (await redis.packed.hGet<number[]>(cacheKey, hashKey)) ?? [];

    // Check if user can proceed and find the failing limit
    let failedLimit: RateLimit | undefined = undefined;
    let canProceed = true;

    for (const rateLimitRule of validLimits) {
      const { limit, period } = rateLimitRule;
      if (limit === 0) {
        failedLimit = rateLimitRule;
        canProceed = false;
        break;
      }

      const cutoff = Date.now() - period! * 1000;
      const relevantAttempts = attempts.filter((x) => x > cutoff).length;
      if (relevantAttempts > limit!) {
        failedLimit = rateLimitRule;
        canProceed = false;
        break;
      }
    }

    // Throw if rate limit exceeded
    if (!canProceed && failedLimit) {
      const errorMessage = failedLimit.errorMessage ?? `You're doing that too much...`;
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: errorMessage,
      });
    }

    // Record this attempt against the user's quota
    const recordAttempt = async () => {
      attempts.push(Date.now());
      const longestPeriod = Math.max(...validLimits.map((x) => x.period!));
      const updatedAttempts = attempts.filter((x) => x > Date.now() - longestPeriod * 1000);
      // Atomic packed-write: single EVAL replaces racy Promise.all([hSet, hExpire]).
      //
      // Fail-open wrapper (PR #2332 round-4 audit fix): without this
      // try/catch, an in-flight EVAL throw during a sysRedis (cache
      // client) failover would 500 every authed mutation that flows
      // through this middleware. Trade-off documented under the
      // `rate-limit-write-degraded` subtype: the current request is
      // allowed through and the sliding-window quota under-counts the
      // attempt until the next successful write. A sustained spike on
      // that subtype = abuse-prevention effectively disabled, which
      // ops should dashboard separately from generic write-degraded.
      try {
        await hSetWithTTL(redis, cacheKey, hashKey, pack(updatedAttempts), CacheTTL.day * 1000);
      } catch (error) {
        logSysRedisFailOpen('rate-limit-write-degraded', 'middleware.trpc.recordAttempt', error, {
          cacheKey,
          hashKey,
        });
      }
    };

    // When onlyCountSuccess is set, defer recording until the procedure succeeds
    // so failed calls don't burn a slot.
    if (options?.onlyCountSuccess) {
      const result = await next();
      if (result.ok) await recordAttempt();
      return result;
    }

    await recordAttempt();
    return await next();
  });
}

export type InFlightLimit = {
  /** Procedures given the same bucket share one per-user limit. */
  bucket: string;
  limit: number;
  /** A request still running after this stops counting against the limit. */
  ttlMs: number;
  /** A store slower than this is treated as failed, so a stalled Redis cannot stall the request. */
  acquireTimeoutMs: number;
  errorMessage: string;
};
const ACQUIRE_TIMED_OUT: ConcurrencySlot = { acquired: false, reason: 'unavailable' };
/**
 * Caps a user's concurrent requests (`rateLimit` caps rate). Admits when the store fails or takes
 * longer than `acquireTimeoutMs`.
 */
export function inFlightLimit({
  bucket,
  limit,
  ttlMs,
  acquireTimeoutMs,
  errorMessage,
}: InFlightLimit) {
  return middleware(async ({ ctx, next }) => {
    if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });

    const key = `${REDIS_KEYS.TRPC.IN_FLIGHT}:${bucket}:${ctx.user.id}`;
    const acquiring = acquireConcurrencySlot(key, limit, ttlMs);
    const slot = await withTimeoutFallback(acquiring, acquireTimeoutMs, ACQUIRE_TIMED_OUT, () => {
      // A slot granted after we stopped waiting would otherwise count until its TTL.
      void acquiring.then((late) => (late.acquired ? late.release() : undefined));
    });
    if (!slot.acquired) {
      if (slot.reason === 'full')
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: errorMessage });
      logSysRedisFailOpen('read-degraded', 'middleware.trpc.inFlightLimit', slot.error, {
        bucket,
        userId: ctx.user.id,
      });
      return await next();
    }

    try {
      return await next();
    } finally {
      // Not awaited: the work is done, and a stalled store must not hold the response.
      void slot.release();
    }
  });
}

/**
 * Purchases and box opens each hold a pooled connection while waiting on the buyer's
 * `lockItemHolder` (at most `ITEM_HOLDER_LOCK_TIMEOUT`), so they share one bucket.
 */
export const itemHolderInFlightLimit = inFlightLimit({
  bucket: 'item-holder',
  limit: 2,
  ttlMs: 60_000,
  acquireTimeoutMs: 500,
  errorMessage: ITEM_HOLDER_BUSY_MESSAGE,
});

const EDGE_TAG_SET_CAP = 100;
// Per-tag caps, matched by tag prefix, for a tag whose legitimate URL count approaches the default.
const EDGE_TAG_SET_CAPS: Record<string, number> = {};
export function edgeTagSetCap(tag: string) {
  for (const [prefix, cap] of Object.entries(EDGE_TAG_SET_CAPS))
    if (tag.startsWith(prefix)) return cap;
  return EDGE_TAG_SET_CAP;
}

const encodeTrpcQuery = (input: unknown) =>
  `input=${encodeURIComponent(JSON.stringify(superjson.serialize(input)))}`;

/**
 * Exactly a URL the site's tRPC client sends for this parsed input, and no other form of it. The
 * client spreads every object input and adds `authed: true` when signed in (see
 * `authedCacheBypassLink` in `src/utils/trpc.ts`), so no input arrives as `{}`.
 */
export function isCanonicalTrpcGetUrl(url: string, input: unknown) {
  const q = url.indexOf('?');
  if (q === -1) return false;
  const query = url.slice(q + 1);
  const sent = input === undefined ? {} : input;
  if (query === encodeTrpcQuery(sent)) return true;
  return (
    typeof sent === 'object' &&
    sent !== null &&
    !Array.isArray(sent) &&
    query === encodeTrpcQuery({ ...sent, authed: true })
  );
}

const capLoggedTags = new Set<string>();

/**
 * A purge can only refresh URLs recorded under the tag, so a tagged response is edge-cached only
 * when its URL was recorded. Bounded per tag; past the bound the response is served uncached.
 */
/** @returns how long the response may be cached (seconds), 0 when it must not be. */
async function recordTaggedUrl(
  url: string,
  input: unknown,
  tags: string[],
  ttl: number,
  path: string
) {
  if (!isCanonicalTrpcGetUrl(url, input)) return 0;
  try {
    const recorded = await Promise.all(
      tags.map((tag) =>
        sAddCappedWithExpireGe(
          redis,
          `${REDIS_KEYS.CACHES.EDGE_CACHED}:${tag}`,
          url,
          ttl,
          edgeTagSetCap(tag)
        )
      )
    );
    tags.forEach((tag, i) => {
      if (recorded[i] > 0 || capLoggedTags.has(tag) || capLoggedTags.size >= 1000) return;
      capLoggedTags.add(tag);
      logToAxiom(
        // Only a URL in the client's own form reaches this point, so `url` is one the site requests.
        { name: 'edge-cache-tag-cap', type: 'warn', tag, cap: edgeTagSetCap(tag), path, url },
        'civitai-prod'
      ).catch(() => undefined);
    });
    return Math.min(...recorded);
  } catch (error) {
    logToAxiom(
      { name: 'edge-cache-record-failed', type: 'error', message: (error as Error).message, tags },
      'civitai-prod'
    ).catch(() => undefined);
    return 0;
  }
}

export type EdgeCacheItProps = {
  ttl?: number;
  expireAt?: () => Date;
  tags?: (input: any) => string[];
};
export function edgeCacheIt({ ttl = 60 * 3, expireAt, tags }: EdgeCacheItProps = {}) {
  return middleware(async ({ next, ctx, input, path }) => {
    // SSG prefetch path: no HTTP response to decorate with cache headers.
    // ctx.cache is null when the call comes through createServerSideHelpers.
    if (!ctx.cache) return await next();
    if (!!ctx.req?.query?.batch) {
      const message = `Content not cached: ${path}`;
      if (!isProd) console.log(message);
      else logToAxiom({ name: 'edge-cache-it', type: 'warn', message }, 'civitai-prod').catch();
      return await next();
    }
    if (!isProd) return await next();
    let reqTTL = ctx.cache.skip ? 0 : (ttl as number);
    if (expireAt) reqTTL = Math.floor((expireAt().getTime() - Date.now()) / 1000);

    const result = await next();
    // Re-read `skip` now that the resolver has run. The read above happens before
    // `next()`, so a resolver that only knows its response is uncacheable once it has
    // produced it (e.g. `home-block.getHomeBlock` on an Announcement block) sets a flag
    // nothing looks at again. `canCache` is already read on the line below, after the
    // resolver, and this puts `skip` on the same footing.
    //
    // PRECEDENCE, deliberate and now pinned by test: `skip` BEATS `expireAt`. Sitting
    // after the `expireAt` assignment above, this line overrides a scheduled expiry
    // rather than being overridden by it. That is the intended ordering — `expireAt`
    // says "this content goes stale at time T", which is a statement about content that
    // IS cacheable, whereas `skip` says "this particular response must not be cached at
    // all". A response the resolver has declared uncacheable does not become cacheable
    // because someone also scheduled when it should expire; the stronger claim wins.
    // (Before this line existed the ordering was the other way round and nothing said
    // so, so it was accidental rather than chosen.) Reintroducing an `expireAt` guard
    // here — `if (ctx.cache?.skip && !expireAt)` — is caught by
    // `middleware.trpc.edge-cache-precedence.test.ts`.
    if (ctx.cache?.skip) reqTTL = 0;
    if (result.ok && ctx.cache?.canCache) {
      const cacheTags = tags?.(input).map((x) => slugit(x));
      if (cacheTags && ctx.req?.url && reqTTL > 0) {
        const recordedFor = await recordTaggedUrl(ctx.req.url, input, cacheTags, ttl, path);
        if (!recordedFor) {
          ctx.cache.canCache = false;
          ctx.cache.edgeTTL = 0;
          ctx.cache.browserTTL = 0;
          return result;
        }
        reqTTL = Math.min(reqTTL, recordedFor);
      }
      ctx.cache.browserTTL = isProd ? Math.min(60, reqTTL) : 0;
      ctx.cache.edgeTTL = reqTTL;
      ctx.cache.staleWhileRevalidate = 30;
      if (cacheTags) ctx.cache.tags = cacheTags;
    }

    return result;
  });
}

export function purgeOnSuccess(tags: string[]) {
  return middleware(async ({ next, path }) => {
    const result = await next();
    // Not awaited: the save returns while the edge refresh runs. If the refresh fails, the
    // cached response stays until its TTL runs out.
    if (result.ok)
      purgeCache({ tags }).catch((error: Error) =>
        logToAxiom(
          { name: 'edge-purge-failed', type: 'error', message: error.message, tags, path },
          'civitai-prod'
        ).catch(() => undefined)
      );

    return result;
  });
}

export function noEdgeCache(opts?: { authedOnly?: boolean }) {
  const { authedOnly } = opts ?? {};

  return middleware(({ next, ctx }) => {
    if (authedOnly && !ctx.user) return next();

    if (ctx.cache) {
      ctx.cache.edgeTTL = 0;
      ctx.cache.browserTTL = 0;
    }

    return next();
  });
}

export const prodOnly = middleware(({ next }) => {
  if (!isProd) throw new TRPCError({ code: 'FORBIDDEN', message: 'Not available in development' });
  return next();
});

export const applyRequestDomainColor = middleware(async (options) => {
  const { next, ctx } = options;
  // Procedures with a fully-optional input must use `.default({})` (not `.optional()`)
  // so there's an object to stamp the domain onto when the caller sends no input.
  const input = options.input as { domain?: string } | undefined;
  if (input) input.domain = getRequestDomainColor(ctx.req);

  return next();
});

/**
 * Same contract as `applyRequestDomainColor`, but resolves `red` for red-capable
 * hosts — see `getRequestBoardDomainColor`. Use this for anything that has SFW and
 * mature variants of the same content; the plain color walk never yields `red`.
 *
 * Must be `.use()`d BEFORE `cacheIt`, which keys on a hash of the input: a domain
 * stamped afterwards would leave one cache entry shared across every color.
 */
export const applyRequestBoardDomainColor = middleware(async (options) => {
  const { next, ctx } = options;
  const input = options.input as { domain?: string } | undefined;
  if (input) input.domain = getRequestBoardDomainColor(ctx.req);

  return next();
});
