import { BaseQuerySchema } from './schema/base.schema';
import superjson from 'superjson';
import { isProd } from '~/env/other';
import { purgeCache } from '~/server/cloudflare/client';
import { logToAxiom } from '~/server/logging/client';
import { redis } from '~/server/redis/client';
import { UserPreferencesInput } from '~/server/schema/base.schema';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { middleware } from '~/server/trpc';
import { Flags } from '~/shared/utils';
import { hashifyObject, slugit } from '~/utils/string-helpers';

export const queryMiddleware = middleware(({ input, ctx, next }) => {
  const _input = input as BaseQuerySchema;
  _input.isOwner = (ctx.user && ctx.user.username === _input.username) ?? false;
  _input.isModerator = !!_input.username && !!ctx.user?.isModerator;
  _input.browsingLevel = _input.browsingLevel ?? ctx.browsingLevel;
  return next({
    ctx: { user: ctx.user },
  });
});

export const applyUserPreferences = middleware(async ({ input, ctx, next }) => {
  const _input = input as UserPreferencesInput;

  const browsingLevel = _input.browsingLevel ?? ctx.browsingLevel;
  const { hiddenImages, hiddenTags, hiddenModels, hiddenUsers } = await getAllHiddenForUser({
    userId: ctx.user?.id,
  });

  // TODO.nsfwLevel - determine if we still need to filter by hidden tags. Now we have nsfwLevel
  const tagsToHide = hiddenTags
    .filter((x) => !x.nsfwLevel || !Flags.hasFlag(browsingLevel, x.nsfwLevel))
    .map((x) => x.id);

  const imagesToHide = hiddenImages
    .filter((x) => !x.tagId || tagsToHide.findIndex((tagId) => tagId === x.tagId) > -1)
    .map((x) => x.id);

  _input.browsingLevel = browsingLevel;
  _input.excludedTagIds = [...(_input.excludedTagIds ?? []), ...tagsToHide];
  _input.excludedImageIds = [...(_input.excludedImageIds ?? []), ...imagesToHide];
  _input.excludedUserIds = [...(_input.excludedUserIds ?? []), ...hiddenUsers.map((x) => x.id)];
  _input.excludedModelIds = [...(_input.excludedModelIds ?? []), ...hiddenModels.map((x) => x.id)];

  return next({
    ctx: { user: ctx.user },
  });
});

type CacheItProps<TInput extends object> = {
  key?: string;
  ttl?: number;
  excludeKeys?: (keyof TInput)[];
};
export function cacheIt<TInput extends object>({
  key,
  ttl,
  excludeKeys,
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
    const cacheKey = `trpc:${key ?? path.replace('.', ':')}:${hashifyObject(cacheKeyObj)}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      const data = superjson.parse(cached);
      return { ok: true, data, marker: 'fromCache' as any, ctx };
    }

    const result = await next({ ctx });
    if (result.ok && result.data && ctx.cache?.canCache) {
      await redis.set(cacheKey, superjson.stringify(result.data), {
        EX: ttl,
      });
    }

    return result;
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
      ctx.cache.tags = tags?.(input).map((x) => slugit(x));
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
