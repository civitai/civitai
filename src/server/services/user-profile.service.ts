import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { userWithProfileSelect } from '~/server/selectors/user.selector';
import type {
  GetUserProfileSchema,
  PrivacySettingsSchema,
  ProfileSectionSchema,
  ShowcaseItemSchema,
  UserProfileUpdateSchema,
} from '~/server/schema/user-profile.schema';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';
import { enqueueImageIngestion } from '~/server/services/image.service';
import type { UserMeta } from '~/server/schema/user.schema';
import { getUserBanDetails } from '~/utils/user-helpers';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import {
  getUserContentOverview as getUserContentOverviewFromCache,
  getUserContentOverviewPublic as getUserContentOverviewPublicFromCache,
  getUserContentOverviewSfw as getUserContentOverviewSfwFromCache,
} from '~/server/redis/caches';
import { userUpdateCounter } from '~/server/prom/client';
import { usersSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

export type UserContentOverviewVariant = 'public' | 'sfw' | 'all';

export const getUserContentOverview = async ({
  username,
  userId,
  variant = 'all',
}: {
  username?: string;
  userId?: number;
  variant?: UserContentOverviewVariant;
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
      throw throwNotFoundError('User not found');
    }

    userId = user.id;
  }

  const fetchFn =
    variant === 'public'
      ? getUserContentOverviewPublicFromCache
      : variant === 'sfw'
      ? getUserContentOverviewSfwFromCache
      : getUserContentOverviewFromCache;
  const data = await fetchFn([userId]);
  return data[userId];
};

export const getUserWithProfile = async ({
  username,
  id,
  tx,
  isModerator,
  sessionUserId,
}: GetUserProfileSchema & {
  tx?: Prisma.TransactionClient;
  isModerator?: boolean;
  sessionUserId?: number;
}) => {
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
      select: {
        ...userWithProfileSelect,
        bannedAt: true,
        meta: true,
        publicSettings: true,
        settings: true,
      },
    });

    // Becuase this is a view, it might be slow and we prefer to get the stats in a separate query
    // Ideally, using dbRead.
    const stats = await dbRead.userStat.findFirst({
      where: {
        userId: user.id,
      },
      select: {
        downloadCountAllTime: true,
        thumbsUpCountAllTime: true,
        followerCountAllTime: true,
        reactionCountAllTime: true,
        uploadCountAllTime: true,
        generationCountAllTime: true,
      },
    });

    const { profile } = user;
    const userMeta = (user.meta ?? {}) as UserMeta;
    const coverImage = profile?.coverImage;
    const coverNeedsReview =
      coverImage?.needsReview || coverImage?.ingestion === ImageIngestionStatus.Blocked;
    const sameUser = sessionUserId === user.id;

    return {
      ...user,
      meta: undefined,
      // Never leak the private settings blob; expose only whether the shop is public.
      settings: undefined,
      creatorShopEnabled:
        (user.settings as { creatorShop?: { enabled?: boolean } } | null)?.creatorShop?.enabled ===
        true,
      ...getUserBanDetails({
        meta: userMeta,
        isModerator: isModerator ?? false,
      }),
      stats: stats,
      profile: {
        ...profile,
        privacySettings: (profile?.privacySettings ?? {}) as PrivacySettingsSchema,
        profileSectionsSettings: (profile?.profileSectionsSettings ?? []) as ProfileSectionSchema[],
        showcaseItems: (profile?.showcaseItems ?? []) as ShowcaseItemSchema[],
        coverImage:
          coverImage && (isModerator || sameUser || !coverNeedsReview)
            ? {
                ...coverImage,
                meta: coverImage.meta as ImageMetaProps | null,
                metadata: coverImage.metadata as MixedObject,
                tags: coverImage.tags.map((t) => t.tag),
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

    userUpdateCounter?.inc({ location: 'user-profile.service:updateProfile' });
  }

  const { coverImage: updatedCoverImage } = await dbWrite.$transaction(
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
                        metadata: { coverImage: true, userId },
                        userId,
                        resources: undefined,
                      },
                    },
                  }
              : undefined,
        },
      });

      return updatedProfile;
    },
    {
      timeout: 15000,
    }
  );

  // Ingest the cover image AFTER the transaction commits. ingestImage makes a
  // blocking external HTTP call to the image scanner; keeping it inside the
  // interactive transaction held the txn open past its 15s timeout whenever the
  // scanner was slow ("Transaction already closed: a commit cannot be executed
  // on an expired transaction"). Ingestion only needs the committed Image row,
  // not transactional atomicity with the profile write.
  //
  // Fire-and-forget on purpose: the profile is already saved, so a scanner
  // outage must NOT bubble up as "error updating your profile" on a successful
  // save. Recovery is guaranteed independently — the `trg_image_scan_queue`
  // trigger enqueues an ImageScan JobQueue row on the Pending insert, which the
  // `ingest-images` sweeper drains, so the cover image still gets scanned even
  // if this inline enqueue fails.
  if (updatedCoverImage && updatedCoverImage.ingestion === ImageIngestionStatus.Pending) {
    enqueueImageIngestion({
      images: [updatedCoverImage],
      name: 'user-profile-cover-ingest',
      userId,
    });
  }

  await usersSearchIndex.queueUpdate([{ id: userId, action: SearchIndexUpdateQueueAction.Update }]);

  return getUserWithProfile({ id: userId });
};
