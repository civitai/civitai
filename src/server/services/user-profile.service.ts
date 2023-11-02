import { dbWrite } from '~/server/db/client';
import { userWithProfileSelect } from '~/server/selectors/user.selector';
import {
  GetUserProfileSchema,
  PrivacySettingsSchema,
  ProfileSectionSchema,
  ShowcaseItemSchema,
  UserProfileUpdateSchema,
} from '~/server/schema/user-profile.schema';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { ImageMetadata } from '~/server/schema/media.schema';
import { Prisma } from '@prisma/client';

export const getUserWithProfile = async ({ username, id }: GetUserProfileSchema) => {
  // Use write to get the latest most accurate user here since we'll need to create the profile
  // if it doesn't exist.
  if (!username && !id) {
    throw new Error('Either username or id must be provided');
  }
  const getUser = async () => {
    const user = await dbWrite.user.findUniqueOrThrow({
      where: {
        id,
        username,
        deletedAt: null,
      },
      select: userWithProfileSelect,
    });

    const { profile } = user;

    return {
      ...user,
      profile: {
        ...profile,
        privacySettings: (profile?.privacySettings ?? {}) as PrivacySettingsSchema,
        profileSectionsSettings: (profile?.profileSectionsSettings ?? []) as ProfileSectionSchema[],
        showcaseItems: (profile?.showcaseItems ?? []) as ShowcaseItemSchema[],
        coverImage: profile?.coverImage
          ? {
              ...profile.coverImage,
              meta: profile.coverImage.meta as ImageMetaProps | null,
              tags: profile.coverImage.tags.map((t) => t.tag),
            }
          : null,
      },
    };
  };

  const user = await getUser();

  if (!user.profile) {
    // First time visit to this user's profile. Create base profile:
    await dbWrite.userProfile.upsert({
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

export const updateUserProfile = async ({
  profileImage,
  links,
  badgeId,
  userId,
  coverImage,
  coverImageId,
  ...profile
}: UserProfileUpdateSchema & { userId: number }) => {
  const updatedUserWithProfile = await dbWrite.$transaction(async (tx) => {
    await getUserWithProfile({ id: userId }); // Ensures user exists && has a profile record.
    await tx.user.update({
      where: {
        id: userId,
      },
      data: {
        image: profileImage,
      },
    });

    if (links) {
      await tx.userLink.deleteMany({
        where: {
          userId,
          id: {
            not: {
              in: links.filter((l) => !!l.id).map((l) => l.id),
            },
          },
        },
      });

      const withIndexes = links.map((userLink, index) => ({ ...userLink, userId, index }));
      const toCreate = withIndexes.filter((x) => !x.id);
      const toUpdate = withIndexes.filter((x) => !!x.id);

      if (toCreate.length) {
        await tx.userLink.createMany({ data: toCreate });
      }
      if (toUpdate.length) {
        await Promise.all(
          toUpdate.map(
            async (userLink) =>
              await tx.userLink.updateMany({
                where: { id: userLink.id },
                data: userLink,
              })
          )
        );
      }
    }

    await tx.userProfile.update({
      where: { userId },
      data: {
        ...profile,
      },
    });

    const deletedBounty = await tx.bounty.delete({ where: { id } });
    if (!deletedBounty) return null;

    await tx.file.deleteMany({ where: { entityId: id, entityType: 'Bounty' } });

    return deletedBounty;
  });

  return updatedUserWithProfile;
};
