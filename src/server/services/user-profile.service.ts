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
import { ImageIngestionStatus, LinkType, Prisma } from '@prisma/client';
import { isDefined } from '~/utils/type-guards';
import { ingestImage } from '~/server/services/image.service';

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
        cosmetics:
          badgeId !== undefined
            ? {
                updateMany: {
                  where: { equippedAt: { not: null } },
                  data: { equippedAt: null },
                },
                update: badgeId
                  ? {
                      where: { userId_cosmeticId: { userId, cosmeticId: badgeId } },
                      data: { equippedAt: new Date() },
                    }
                  : undefined,
              }
            : undefined,
      },
    });

    if (links) {
      // First delete all links that are not in the new list
      await tx.userLink.deleteMany({
        where: {
          userId,
          id: {
            not: {
              in: links.map((l) => l.id).filter(isDefined),
            },
          },
          type: LinkType.Social,
        },
      });

      const withIndexes = links.map(({ url, id }, index) => ({
        type: LinkType.Social,
        url,
        userId,
        index,
        id,
      }));
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

    if (badgeId !== undefined) {
      // Set it up:
    }

    const updatedProfile = await tx.userProfile.update({
      select: {
        userId: true,
        coverImage: { select: { id: true, url: true, ingestion: true, type: true } },
      },
      where: { userId },
      data: {
        ...profile,
        coverImage:
          coverImage !== undefined
            ? coverImage === null
              ? { disconnect: true }
              : {
                  connectOrCreate: {
                    where: { id: coverImage.id ?? -1 },
                    create: {
                      ...coverImage,
                      meta: (coverImage?.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
                      userId,
                      resources: undefined,
                    },
                  },
                }
            : undefined,
      },
    });

    if (
      updatedProfile.coverImage &&
      updatedProfile.coverImage.ingestion === ImageIngestionStatus.Pending
    ) {
      await ingestImage({ image: updatedProfile.coverImage });
    }

    return getUserWithProfile({ id: userId });
  });

  return updatedUserWithProfile;
};
