import { purgeCache } from '~/server/cloudflare/client';
import { throwAuthorizationError, throwDbError } from '~/server/utils/errorHandling';
import {
  getUserContentOverview,
  getUserWithProfile,
  updateUserProfile,
} from '~/server/services/user-profile.service';
import type {
  GetUserProfileSchema,
  PrivacySettingsSchema,
  ProfileSectionSchema,
  ShowcaseItemSchema,
  UserProfileUpdateSchema,
} from '~/server/schema/user-profile.schema';
import type { Context, ProtectedContext } from '~/server/createContext';
import { TRPCError } from '@trpc/server';
import { entityExists } from '~/server/services/util.service';
import { constants } from '~/server/common/constants';
import { amIBlockedByUser } from '~/server/services/user.service';

export const getUserContentOverviewHandler = async ({
  input,
  ctx,
}: {
  input: GetUserProfileSchema;
  ctx: Context;
}) => {
  // Pick the overview variant so the counts match what the user can actually browse:
  //   anonymous (any domain)     â†’ 'public' (PG only)
  //   logged-in on green domain  â†’ 'sfw'    (PG + PG-13)
  //   logged-in on blue/red      â†’ 'all'    (respect user preference)
  const variant = !ctx.user ? 'public' : ctx.domain === 'green' ? 'sfw' : 'all';
  try {
    const overview = await getUserContentOverview({
      username: input.username,
      variant,
    });

    return overview;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
export const getUserProfileHandler = async ({
  input,
  ctx,
}: {
  input: GetUserProfileSchema;
  ctx: Context;
}) => {
  try {
    const user = await getUserWithProfile({
      username: input.username,
      isModerator: ctx.user?.isModerator,
      sessionUserId: ctx.user?.id,
    });

    if (ctx.user && !ctx.user.isModerator) {
      const blocked = await amIBlockedByUser({ userId: ctx.user.id, targetUserId: user.id });
      if (blocked) {
        // Return a minimal stub so the viewer can block back. Strip every field
        // that could leak content the blocker doesn't want them to see.
        return {
          ...user,
          blockedByThem: true as const,
          muted: false,
          links: [],
          cosmetics: [],
          rank: null,
          leaderboardShowcase: null,
          stats: null,
          profile: {
            userId: user.id,
            bio: null,
            message: null,
            messageAddedAt: null,
            coverImage: null,
            coverImageId: null,
            location: null,
            nsfw: false,
            showcaseItems: [] as ShowcaseItemSchema[],
            profileSectionsSettings: [] as ProfileSectionSchema[],
            privacySettings: {} as PrivacySettingsSchema,
          },
        };
      }
    }

    return user;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const updateUserProfileHandler = async ({
  input,
  ctx,
}: {
  input: UserProfileUpdateSchema;
  ctx: ProtectedContext;
}) => {
  const { user: sessionUser } = ctx;

  try {
    if ((!sessionUser.isModerator && input.userId !== sessionUser.id) || sessionUser.muted)
      throw throwAuthorizationError();

    const userId = sessionUser.isModerator ? input.userId || sessionUser.id : sessionUser.id;
    const user = await updateUserProfile({
      ...input,
      userId,
    });

    purgeCache({ tags: [`user-creator-${userId}`] }).catch();

    return user;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
export const addEntityToShowcaseHandler = async ({
  input,
  ctx,
}: {
  input: ShowcaseItemSchema;
  ctx: ProtectedContext;
}) => {
  try {
    if (input.entityType !== 'Model' && input.entityType !== 'Image') {
      throw new Error('Invalid entity type. Only models and images are supported right now');
    }

    await entityExists({
      entityType: input.entityType,
      entityId: input.entityId,
    });

    const user = await getUserWithProfile({ id: ctx.user.id });
    const showcaseItems = (user.profile.showcaseItems as ShowcaseItemSchema[]) || [];

    if (
      showcaseItems.find(
        (item) => item.entityId === input.entityId && item.entityType === input.entityType
      )
    ) {
      return user;
    }

    const updatedShowcaseItems = [input, ...showcaseItems].slice(
      0,
      constants.profile.showcaseItemsLimit
    );

    const result = await updateUserProfile({
      userId: ctx.user.id,
      showcaseItems: updatedShowcaseItems,
    });

    purgeCache({ tags: [`user-creator-${ctx.user.id}`] }).catch();

    return result;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
