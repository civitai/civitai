import { throwDbError } from '~/server/utils/errorHandling';
import {
  getUserContentOverview,
  getUserWithProfile,
  updateUserProfile,
} from '~/server/services/user-profile.service';
import {
  GetUserProfileSchema,
  ShowcaseItemSchema,
  UserProfileUpdateSchema,
} from '~/server/schema/user-profile.schema';
import { Context } from '~/server/createContext';
import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';

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
export const getUserProfileHandler = async ({ input }: { input: GetUserProfileSchema }) => {
  try {
    const user = await getUserWithProfile({
      username: input.username,
    });

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
  try {
    const user = await updateUserProfile({
      ...input,
      userId: ctx.user.isModerator ? input.userId || ctx.user.id : ctx.user.id,
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

    if (input.entityType === 'Model') {
      await dbRead.model.findUniqueOrThrow({
        where: { id: input.entityId },
      });
    }

    if (input.entityType === 'Image') {
      await dbRead.image.findUniqueOrThrow({
        where: { id: input.entityId },
      });
    }

    const user = await getUserWithProfile({ id: ctx.user.id });
    const showcaseItems = (user.profile.showcaseItems as ShowcaseItemSchema[]) || [];

    if (
      showcaseItems.find(
        (item) => item.entityId === input.entityId && item.entityType === input.entityType
      )
    ) {
      return user;
    }

    const updatedShowcaseItems = [input, ...showcaseItems].slice(0, 5);

    return await updateUserProfile({
      userId: ctx.user.id,
      showcaseItems: updatedShowcaseItems,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
