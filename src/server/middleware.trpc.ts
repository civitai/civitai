import superjson from 'superjson';
import { z } from 'zod';
import { isProd } from '~/env/other';
import { env } from '~/env/server.mjs';
import { purgeCache } from '~/server/cloudflare/client';

import { logToAxiom } from '~/server/logging/client';
import { redis } from '~/server/redis/client';
import { UserPreferencesInput } from '~/server/schema/base.schema';
import { getHiddenTagsForUser, userCache } from '~/server/services/user-cache.service';
import { middleware } from '~/server/trpc';
import { hashifyObject, slugit } from '~/utils/string-helpers';

export const applyUserPreferences = <TInput extends UserPreferencesInput>() =>
  middleware(async ({ input, ctx, next }) => {
    const _input = input as TInput;
    const browsingLevel = _input.browsingLevel ?? ctx.browsingLevel;

    if (browsingMode !== BrowsingMode.All) {
      const { hidden } = userCache(ctx.user?.id);
      const [hiddenTags, hiddenUsers, hiddenImages] = await Promise.all([
        hidden.tags.get(),
        hidden.users.get(),
        hidden.images.get(),
      ]);

      _input.excludedTagIds = [
        ...hiddenTags.hiddenTags,
        ...hiddenTags.moderatedTags,
        ...(_input.excludedTagIds ?? []),
      ];
      _input.excludedUserIds = [...hiddenUsers, ...(_input.excludedUserIds ?? [])];
      _input.excludedImageIds = [...hiddenImages, ...(_input.excludedUserIds ?? [])];

      if (browsingMode === BrowsingMode.SFW) {
        const systemHidden = await getHiddenTagsForUser({ userId: -1 });
        _input.excludedTagIds = [
          ...systemHidden.hiddenTags,
          ...systemHidden.moderatedTags,
          ...(_input.excludedTagIds ?? []),
        ];
      }
    }

    return next({
      ctx: { user: ctx.user },
    });
  });

type BrowsingModeInput = z.infer<typeof browsingModeSchema>;
const browsingModeSchema = z.object({
  browsingMode: z.nativeEnum(BrowsingMode).default(BrowsingMode.All),
});

export const applyBrowsingMode = <TInput extends BrowsingModeInput>() =>
  middleware(async ({ input, ctx, next }) => {
    const _input = input as TInput;
    const canViewNsfw = ctx.user?.showNsfw ?? env.UNAUTHENTICATED_LIST_NSFW;
    if (canViewNsfw && !_input.browsingMode) _input.browsingMode = BrowsingMode.All;
    else if (!canViewNsfw) _input.browsingMode = BrowsingMode.SFW;

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
    if (!!ctx.req.query.batch) {
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
