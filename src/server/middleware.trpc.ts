import { getHiddenTagsForUser, getHiddenUsersForUser } from '~/server/services/user-cache.service';
import { middleware } from '~/server/trpc';
import { z } from 'zod';
import { BrowsingMode } from '~/server/common/enums';
import { env } from '~/env/server.mjs';

type UserPreferencesInput = z.infer<typeof userPreferencesSchema>;
const userPreferencesSchema = z.object({
  excludedTagIds: z.array(z.number()).optional(),
  excludedUserIds: z.array(z.number()).optional(),
});

export const applyUserPreferences = <TInput extends UserPreferencesInput>() =>
  middleware(async ({ input, ctx, next }) => {
    const userId = ctx.user?.id;
    const _input = input as TInput;
    const hiddenTags = await getHiddenTagsForUser({ userId });
    const hiddenUsers = await getHiddenUsersForUser({ userId });
    _input.excludedTagIds = [...hiddenTags, ...(_input.excludedTagIds ?? [])];
    _input.excludedUserIds = [...hiddenUsers, ...(_input.excludedUserIds ?? [])];

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
