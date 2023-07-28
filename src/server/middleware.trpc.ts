import { getHiddenTagsForUser, userCache } from '~/server/services/user-cache.service';
import { middleware } from '~/server/trpc';
import { z } from 'zod';
import { BrowsingMode } from '~/server/common/enums';
import { env } from '~/env/server.mjs';
import { redis } from '~/server/redis/client';
import { hashifyObject, slugit } from '~/utils/string-helpers';
import { fromJson, toJson } from '~/utils/json-helpers';
import { applyAnonymousUserRules } from '~/server/services/image.service';
import { isProd } from '~/env/other';
import { purgeCache } from '~/server/cloudflare/client';
import { UserPreferencesInput } from '~/server/schema/base.schema';

export const applyUserPreferences = <TInput extends UserPreferencesInput>() =>
  middleware(async ({ input, ctx, next }) => {
    const _input = input as TInput;
    let browsingMode = ctx.user ? _input.browsingMode : undefined;
    if (!browsingMode) browsingMode = ctx.browsingMode;

    if (browsingMode !== BrowsingMode.All) {
      const { hidden } = userCache(ctx.user?.id);
      const hiddenTags = await hidden.tags.get();
      const hiddenUsers = await hidden.users.get();
      const hiddenImages = await hidden.images.get();
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

      if (!ctx.user) await applyAnonymousUserRules(_input.excludedTagIds);
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
    for (const [key, value] of Object.entries(_input)) {
      if (excludeKeys?.includes(key as keyof TInput)) continue;
      if (Array.isArray(value)) cacheKeyObj[key] = [...new Set(value.sort())];

      if (value) cacheKeyObj[key] = value;
    }
    const cacheKey = `trpc:${key ?? path.replace('.', ':')}:${hashifyObject(cacheKeyObj)}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      const data = fromJson(cached);
      return { ok: true, data, marker: 'fromCache' as any, ctx };
    }

    const result = await next();
    if (result.ok) {
      await redis.set(cacheKey, toJson(result.data), {
        EX: ttl,
      });
    }

    return result;
  });
}

type EdgeCacheItProps = {
  ttl?: number | false;
  expireAt?: () => Date;
  tags?: (input: any) => string[];
};
export function edgeCacheIt({ ttl, expireAt, tags }: EdgeCacheItProps = {}) {
  return middleware(async ({ next, ctx, input }) => {
    let reqTTL = ttl === false ? 24 * 60 * 60 : ttl ?? 60 * 3;
    if (expireAt) reqTTL = Math.floor((expireAt().getTime() - Date.now()) / 1000);

    const result = await next();
    if (ctx.cache) {
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
