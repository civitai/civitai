import { dbRead, dbWrite } from '~/server/db/client';
import { userWithProfileSelect } from '~/server/selectors/user.selector';
import {
  GetUserProfileSchema,
  PrivacySettingsSchema,
  ProfileSectionSchema,
  ShowcaseItemSchema,
  UserProfileUpdateSchema,
} from '~/server/schema/user-profile.schema';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { CollectionReadConfiguration, ImageIngestionStatus, Prisma, User } from '@prisma/client';
import { isDefined } from '~/utils/type-guards';
import { ingestImage } from '~/server/services/image.service';
import { equipCosmetic, updateLeaderboardRank } from '~/server/services/user.service';

export const getUserContentOverview = async ({
  username,
  userId,
}: {
  username?: string;
  userId?: number;
}) => {
  if (!username && !userId) {
    throw new Error('Either username or id must be provided');
  }

  if (!userId) {
    const user = await dbWrite.user.findUnique({
      where: { username },
      select: { id: true },
    });

    if (!user) {
      throw new Error('User not found');
    }

    userId = user.id;
  }

  const [data] = await dbRead.$queryRaw<
    {
      id: number;
      modelCount: number;
      imageCount: number;
      videoCount: number;
      postCount: number;
      articleCount: number;
      bountyCount: number;
      bountyEntryCount: number;
      hasReceivedReviews: boolean;
      collectionCount: number;
    }[]
  >`
    SELECT
        (SELECT COUNT(*)::INT FROM "Model" m WHERE m."userId" = u.id AND m."status" = 'Published' AND m.availability != 'Private') as "modelCount",
        (SELECT COUNT(*)::INT FROM "Post" p WHERE p."userId" = u.id AND p."publishedAt" IS NOT NULL AND p.metadata->>'unpublishedAt' IS NULL AND p.availability != 'Private') as "postCount",
        (SELECT COUNT(*)::INT FROM "Image" i
          INNER JOIN "Post" p ON p."id" = i."postId" AND p."publishedAt" IS NOT NULL AND p.metadata->>'unpublishedAt' IS NULL AND p.availability != 'Private'
          WHERE i."ingestion" = 'Scanned' AND i."needsReview" IS NULL AND i."userId" = u.id AND i."postId" IS NOT NULL AND i."type" = 'image'::"MediaType"
        ) as "imageCount",
        (SELECT COUNT(*)::INT FROM "Image" i
          INNER JOIN "Post" p ON p."id" = i."postId" AND p."publishedAt" IS NOT NULL AND p.metadata->>'unpublishedAt' IS NULL AND p.availability != 'Private'
          WHERE i."ingestion" = 'Scanned' AND i."needsReview" IS NULL AND i."userId" = u.id AND i."postId" IS NOT NULL AND i."type" = 'video'::"MediaType"
        ) as "videoCount",
        (SELECT COUNT(*)::INT FROM "Article" a WHERE a."userId" = u.id AND a."publishedAt" IS NOT NULL AND a."publishedAt" <= NOW() AND a.availability != 'Private') as "articleCount",
        (SELECT COUNT(*)::INT FROM "Bounty" b WHERE b."userId" = u.id AND b."startsAt" <= NOW() AND b.availability != 'Private') as "bountyCount",
        (SELECT COUNT(*)::INT FROM "BountyEntry" be WHERE be."userId" = u.id) as "bountyEntryCount",
        (SELECT EXISTS (SELECT 1 FROM "ResourceReview" r INNER JOIN "Model" m ON m.id = r."modelId" AND m."userId" = u.id WHERE r."userId" != u.id)) as "hasReceivedReviews",
        (SELECT COUNT(*)::INT FROM "Collection" c WHERE c."userId" = u.id AND c."read" = ${CollectionReadConfiguration.Public}::"CollectionReadConfiguration" AND c.availability != 'Private') as "collectionCount"
    FROM "User" u
    WHERE u.id = ${userId}
  `;

  return data;
};

export const getUserWithProfile = async ({
  username,
  id,
  tx,
}: GetUserProfileSchema & { tx?: Prisma.TransactionClient }) => {
  const dbClient = tx ?? dbWrite;
  // Use write to get the latest most accurate user here since we'll need to create the profile
  // if it doesn't exist.
  if (!username && !id) {
    throw new Error('Either username or id must be provided');
  }
  const getUser = async () => {
    const user = await dbClient.user.findUniqueOrThrow({
      where: {
        id,
        username,
        deletedAt: null,
      },
      select: { ...userWithProfileSelect, publicSettings: true },
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

  if (!user.profile?.userId) {
    // First time visit to this user's profile. Create base profile:
    await dbClient.userProfile.upsert({
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
  // profileImage,
  socialLinks,
  sponsorshipLinks,
  // badgeId,
  // nameplateId,
  userId,
  coverImage,
  // leaderboardShowcase,
  // profilePicture,
  creatorCardStatsPreferences,
  ...profile
}: UserProfileUpdateSchema & { userId: number }) => {
  const current = await getUserWithProfile({ id: userId }); // Ensures user exists && has a profile record.

  // We can safeuly update creatorCardStatsPreferences out of the transaction as it's not critical
  if (creatorCardStatsPreferences) {
    await dbWrite.$executeRawUnsafe(`
        UPDATE "User"
        SET "publicSettings" = jsonb_set(
          "publicSettings",
          '{creatorCardStatsPreferences}',
          '${JSON.stringify(creatorCardStatsPreferences)}'::jsonb
        )
        WHERE "id" = ${userId}`);
  }

  await dbWrite.$transaction(
    async (tx) => {
      // const shouldUpdateCosmetics = badgeId !== undefined || nameplateId !== undefined;
      // const payloadCosmeticIds: number[] = [];

      // if (badgeId) payloadCosmeticIds.push(badgeId);
      // if (nameplateId) payloadCosmeticIds.push(nameplateId);

      // const shouldUpdateUser = shouldUpdateCosmetics || profileImage || leaderboardShowcase;

      // if (shouldUpdateUser) {
      //   await tx.user.update({
      //     where: {
      //       id: userId,
      //     },
      //     data: {
      //       image: profileImage,
      //       leaderboardShowcase,
      //       profilePicture:
      //         profilePicture === null
      //           ? { delete: true }
      //           : profilePicture
      //           ? {
      //               delete: true,
      //               upsert: {
      //                 where: { id: profilePicture.id },
      //                 update: {
      //                   ...profilePicture,
      //                   userId,
      //                 },
      //                 create: {
      //                   ...profilePicture,
      //                   userId,
      //                 },
      //               },
      //             }
      //           : undefined,
      //     },
      //   });

      //   if (shouldUpdateCosmetics) await equipCosmetic({ userId, cosmeticId: payloadCosmeticIds });

      //   if (leaderboardShowcase !== undefined) {
      //     await updateLeaderboardRank({ userIds: userId });
      //   }
      // }

      const links = [...(socialLinks ?? []), ...(sponsorshipLinks ?? [])];

      if (socialLinks !== undefined || sponsorshipLinks !== undefined) {
        await tx.userLink.deleteMany({
          where: {
            userId,
            id: {
              not: {
                in: links.map((l) => l.id).filter(isDefined),
              },
            },
          },
        });

        const parsed = links.map(({ url, id, type }) => ({
          type,
          url,
          userId,
          id,
        }));

        const toCreate = parsed.filter((x) => !x.id);
        const toUpdate = parsed.filter((x) => !!x.id);

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

      const updatedProfile = await tx.userProfile.update({
        select: {
          userId: true,
          coverImage: { select: { id: true, url: true, ingestion: true, type: true } },
        },
        where: { userId },
        data: {
          ...profile,
          messageAddedAt:
            profile.message === undefined || profile.message === current?.profile?.message
              ? undefined
              : profile.message
              ? new Date()
              : null,
          coverImage:
            coverImage !== undefined && !coverImage?.id
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
        await ingestImage({ image: updatedProfile.coverImage, tx });
      }
    },
    {
      // Wait double of time because it might be a long transaction
      timeout: 15000,
    }
  );

  return getUserWithProfile({ id: userId });
};
