import { TRPCError } from '@trpc/server';
import { isDev, isProd, isTest } from '~/env/other';
import { purgeCache } from '~/server/cloudflare/client';
import { CacheTTL } from '~/server/common/constants';
import { logToAxiom } from '~/server/logging/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { UserPreferencesInput } from '~/server/schema/base.schema';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { middleware } from '~/server/trpc';
import { getRequestDomainColor } from '~/shared/constants/domain.constants';
import type { ExtendedUser } from '~/types/next-auth';
import { hashifyObject, slugit } from '~/utils/string-helpers';
import { booleanString } from '~/utils/zod-helpers';

export const applyUserPreferences = middleware(async ({ input, ctx, next }) => {
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

type CacheItProps<TInput extends object> = {
  key?: string;
  ttl?: number;
  excludeKeys?: (keyof TInput)[];
  tags?: (input: TInput) => string[];
};
export function cacheIt<TInput extends object>({
  key,
  ttl,
  excludeKeys,
  tags,
}: CacheItProps<TInput> = {}) {
  ttl ??= 60 * 3;

  return middleware(async ({ input, ctx, next, path }) => {
    const _input = input as TInput;
    const cacheKeyObj: Record<string, any> = {};
    if (_input) {
      for (const [key, value] of Object.entries(_input)) {
        if (excludeKeys?.includes(key as keyof TInput)) continue;
        if (Array.isArray(value)) cacheKeyObj[key] = [...new Set(value.sort())];

        if (value) cacheKeyObj[key] = value;
      }
    }
    const cacheKey = `${REDIS_KEYS.TRPC.BASE}:${key ?? path.replace('.', ':')}:${hashifyObject(
      cacheKeyObj
    )}` as const;
    const cached = await redis.packed.get(cacheKey);
    if (cached) {
      return { ok: true, data: cached, marker: 'fromCache' as any, ctx };
    }

    const result = await next({ ctx });
    if (result.ok && result.data && ctx.cache?.canCache) {
      const cacheTags = tags?.(_input).map((x) => slugit(x));
      await redis.packed.set(cacheKey, result.data, {
        EX: ttl,
      });

      if (cacheTags) {
        await Promise.all(
          cacheTags
            .map((tag) => {
              const key = `${REDIS_KEYS.CACHES.TAGGED_CACHE}:${tag}` as const;
              return [redis.sAdd(key, cacheKey), redis.expire(key, ttl)];
            })
            .flat()
        );
      }
    }

    return result;
  });
}

export type RateLimit = {
  limit: number;
  period: number; // seconds
  userReq?: (user: ExtendedUser) => boolean;
  errorMessage?: string;
};
export function rateLimit<TInput = any>(
  rateLimits?: RateLimit | RateLimit[],
  condition?: (input: TInput) => boolean
) {
  if (!rateLimits) rateLimits = { limit: 10, period: CacheTTL.md };
  if (!Array.isArray(rateLimits)) rateLimits = [rateLimits];

  return middleware(async ({ ctx, input, next, path }) => {
    // Skip if user is a moderator
    if (ctx.user?.isModerator || isDev || isTest) return await next();

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

    // Get user's attempts
    const cacheKey = `${REDIS_KEYS.TRPC.LIMIT.BASE}:${path.replace('.', ':')}` as const;
    const hashKey = ctx.user?.id?.toString() ?? ctx.ip;
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

    // Update user's attempts
    attempts.push(Date.now());
    const longestPeriod = Math.max(...validLimits.map((x) => x.period!));
    const updatedAttempts = attempts.filter((x) => x > Date.now() - longestPeriod * 1000);
    await Promise.all([
      redis.packed.hSet(cacheKey, hashKey, updatedAttempts),
      redis.hExpire(cacheKey, hashKey, CacheTTL.day),
    ]);
    return await next();
  });
}

export type EdgeCacheItProps = {
  ttl?: number;
  expireAt?: () => Date;
  tags?: (input: any) => string[];
};
export function edgeCacheIt({ ttl = 60 * 3, expireAt, tags }: EdgeCacheItProps = {}) {
  return middleware(async ({ next, ctx, input, path }) => {
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
    if (result.ok && ctx.cache?.canCache) {
      ctx.cache.browserTTL = isProd ? Math.min(60, reqTTL) : 0;
      ctx.cache.edgeTTL = reqTTL;
      ctx.cache.staleWhileRevalidate = 30;
      const cacheTags = tags?.(input).map((x) => slugit(x));
      if (cacheTags) {
        if (ctx.req?.url) {
          await Promise.all(
            cacheTags
              .map((tag) => {
                const key = `${REDIS_KEYS.CACHES.EDGE_CACHED}:${tag}` as const;
                return [redis.sAdd(key, ctx.req.url!), redis.expire(key, ttl)];
              })
              .flat()
          );
        }
        ctx.cache.tags = cacheTags;
      }
    }

    return result;
  });
}

export function purgeOnSuccess(tags: string[]) {
  return middleware(async ({ next }) => {
    const result = await next();
    if (result.ok) await purgeCache({ tags });

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
  const input = options.input as { domain?: string };
  const domainColor = getRequestDomainColor(ctx.req);

  if (input.domain && input.domain !== domainColor) input.domain = domainColor;
  else input.domain = domainColor;

  return next();
});
