import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  getUserContentOverview,
  getUserWithProfile,
  updateUserProfile,
} from '~/server/services/user-profile.service';
import type {
  GetUserProfileSchema,
  ShowcaseItemSchema,
  UserProfileUpdateSchema,
} from '~/server/schema/user-profile.schema';
import type { Context } from '~/server/createContext';
import { TRPCError } from '@trpc/server';
import { entityExists } from '~/server/services/util.service';
import { constants } from '~/server/common/constants';
import { amIBlockedByUser } from '~/server/services/user.service';

export const getUserContentOverviewHandler = async ({ input }: { input: GetUserProfileSchema }) => {
  try {
    const overview = await getUserContentOverview({
      username: input.username,
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
      if (blocked) throw throwNotFoundError();
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
  ctx: DeepNonNullable<Context>;
}) => {
  const { user: sessionUser } = ctx;

  try {
    if ((!sessionUser.isModerator && input.userId !== sessionUser.id) || sessionUser.muted)
      throw throwAuthorizationError();

    const user = await updateUserProfile({
      ...input,
      userId: sessionUser.isModerator ? input.userId || sessionUser.id : sessionUser.id,
    });

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
  ctx: DeepNonNullable<Context>;
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

    return await updateUserProfile({
      userId: ctx.user.id,
      showcaseItems: updatedShowcaseItems,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
