import { throwDbError } from '~/server/utils/errorHandling';
import { getUserWithProfile } from '~/server/services/user-profile.service';
import { GetUserProfileSchema } from '~/server/schema/user-profile.schema';

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
