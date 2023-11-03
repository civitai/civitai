import { throwDbError } from '~/server/utils/errorHandling';
import {
  getUserContentOverview,
  getUserWithProfile,
  updateUserProfile,
} from '~/server/services/user-profile.service';
import { GetUserProfileSchema, UserProfileUpdateSchema } from '~/server/schema/user-profile.schema';
import { Context } from '~/server/createContext';
import { TRPCError } from '@trpc/server';

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
