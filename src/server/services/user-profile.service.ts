import { dbWrite } from '~/server/db/client';
import { userWithProfileSelect } from '~/server/selectors/user.selector';
import { GetUserProfileSchema } from '~/server/schema/user-profile.schema';
import { ImageMetaProps } from '~/server/schema/image.schema';

export const getUserWithProfile = async ({ username }: GetUserProfileSchema) => {
  // Use write to get the latest most accurate user here since we'll need to create the profile
  // if it doesn't exist.
  const getUser = async () => {
    const user = await dbWrite.user.findUniqueOrThrow({
      where: {
        username,
        deletedAt: null,
      },
      select: userWithProfileSelect,
    });

    const { profile } = user;
    let coverImage = undefined;

    if (!!profile?.coverImage) {
      coverImage = {
        ...profile.coverImage,
        meta: profile.coverImage.meta as ImageMetaProps | null,
        tags: profile.coverImage.tags.map((t) => t.tag),
      };
    }

    return {
      ...user,
      profile: {
        ...profile,
        coverImage,
      },
    };
  };
  const user = await getUser();

  if (!user.profile) {
    // First time visit to this user's profile. Create base profile:
    const profile = await dbWrite.userProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
      },
      // Basically we wanna avoid a
      // racing condition where 2 users landed here and trigger
      // this at the same time.
      update: {},
      select: { userId: true },
    });

    return getUser();
  }

  return user;
};
