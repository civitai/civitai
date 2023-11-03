import { throwDbError } from '~/server/utils/errorHandling';
import { getUserWithProfile, updateUserProfile } from '~/server/services/user-profile.service';
import { GetUserProfileSchema, UserProfileUpdateSchema } from '~/server/schema/user-profile.schema';
import { Context } from '~/server/createContext';

export const getUserProfileHandler = async ({ input }: { input: GetUserProfileSchema }) => {
  try {
    const user = await getUserWithProfile({
      username: input.username,
    });

    return user;
  } catch (error) {
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
    console.log(error);
    throw throwDbError(error);
  }
};
