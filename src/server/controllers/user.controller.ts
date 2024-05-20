import {
  CosmeticType,
  ModelEngagementType,
  ModelVersionEngagementType,
  NotificationCategory,
} from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { orderBy } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { RECAPTCHA_ACTIONS, constants } from '~/server/common/constants';
import { Context } from '~/server/createContext';
import { dbRead, dbWrite } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import * as rewards from '~/server/rewards';
import { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import {
  BatchBlockTagsSchema,
  DeleteUserInput,
  GetAllUsersInput,
  GetByUsernameSchema,
  GetUserByUsernameSchema,
  GetUserCosmeticsSchema,
  GetUserTagsSchema,
  ReportProhibitedRequestInput,
  SetUserSettingsInput,
  ToggleBlockedTagSchema,
  ToggleFavoriteInput,
  ToggleFeatureInput,
  ToggleFollowUserSchema,
  ToggleModelEngagementInput,
  ToggleUserArticleEngagementsInput,
  ToggleUserBountyEngagementsInput,
  UserByReferralCodeSchema,
  UserOnboardingSchema,
  UserSettingsSchema,
  UserUpdateInput,
} from '~/server/schema/user.schema';
import {
  BadgeCosmetic,
  NamePlateCosmetic,
  ProfileBackgroundCosmetic,
  ContentDecorationCosmetic,
  WithClaimKey,
} from '~/server/selectors/cosmetic.selector';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import {
  claimCosmetic,
  createUserReferral,
  deleteUser,
  getCreators,
  getUserById,
  getUserByUsername,
  getUserCosmetics,
  getUserCreator,
  getUserEngagedModelVersions,
  getUserEngagedModels,
  getUsers,
  isUsernamePermitted,
  toggleBan,
  toggleFollowUser,
  toggleHideUser,
  toggleModelNotify,
  toggleModelHide,
  toggleUserArticleEngagement,
  toggleUserBountyEngagement,
  updateLeaderboardRank,
  updateUserById,
  userByReferralCode,
  equipCosmetic,
  deleteUserProfilePictureCache,
  getUserSettings,
  setUserSetting,
  unequipCosmeticByType,
  getUserBookmarkCollections,
  getUserPurchasedRewards,
  toggleModelEngagement,
  toggleBookmarked,
  toggleReview,
  getUserDownloads,
} from '~/server/services/user.service';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
  withRetries,
} from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { invalidateSession } from '~/server/utils/session-helpers';
import { isUUID } from '~/utils/string-helpers';
import { getUserBuzzBonusAmount } from '../common/user-helpers';
import { TransactionType } from '../schema/buzz.schema';
import { createBuzzTransaction } from '../services/buzz.service';
import { firstDailyFollowReward } from '~/server/rewards/active/firstDailyFollow.reward';
import { deleteImageById, getEntityCoverImage, ingestImage } from '../services/image.service';
import {
  createCustomer,
  deleteCustomerPaymentMethod,
  getCustomerPaymentMethods,
} from '~/server/services/stripe.service';
import { PaymentMethodDeleteInput } from '~/server/schema/stripe.schema';
import { isProd } from '~/env/other';
import { getUserNotificationCount } from '~/server/services/notification.service';
import { createRecaptchaAssesment } from '../recaptcha/client';
import { FeatureAccess, toggleableFeatures } from '../services/feature-flags.service';
import { isDefined } from '~/utils/type-guards';
import {
  OnboardingComplete,
  OnboardingSteps,
  SearchIndexUpdateQueueAction,
} from '~/server/common/enums';
import { Flags } from '~/shared/utils';
import {
  getResourceReviewsByUserId,
  getUserResourceReview,
} from '~/server/services/resourceReview.service';
import { usersSearchIndex } from '~/server/search-index';
import { onboardingCompletedCounter, onboardingErrorCounter } from '~/server/prom/client';

export const getAllUsersHandler = async ({
  input,
  ctx,
}: {
  input: GetAllUsersInput;
  ctx: Context;
}) => {
  try {
    const users = await getUsers({
      ...input,
      email: ctx.user?.isModerator ? input.email : undefined,
    });

    return users;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getUserCreatorHandler = async ({
  input: { username, id, leaderboardId },
}: {
  input: GetUserByUsernameSchema;
}) => {
  if (!username && !id) throw throwBadRequestError('Must provide username or id');
  if (id === constants.system.user.id || username === constants.system.user.username) return null;

  try {
    const user = await getUserCreator({ username, id, leaderboardId });
    if (!user) throw throwNotFoundError('Could not find user');

    return user;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getUsernameAvailableHandler = async ({
  input,
  ctx,
}: {
  input: GetByUsernameSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    if (!isUsernamePermitted(input.username)) return false;
    const user = await getUserByUsername({ ...input, select: { id: true } });
    return !user || user.id === ctx.user.id;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const getUserByIdHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const user = await getUserById({ ...input, select: simpleUserSelect });
    if (!user) throw throwNotFoundError(`No user with id ${input.id}`);

    return user;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const getNotificationSettingsHandler = async ({
  ctx,
}: {
  ctx: DeepNonNullable<Context>;
}) => {
  const { id } = ctx.user;

  try {
    const notificationsSettings = await dbRead.userNotificationSettings.findMany({
      where: { userId: id },
      select: { id: true, type: true, disabledAt: true },
    });

    return notificationsSettings;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const checkUserNotificationsHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  const { id } = ctx.user;

  try {
    const unreadCount = await getUserNotificationCount({
      userId: id,
      unread: true,
    });

    const reduced = unreadCount.reduce(
      (acc, { category, count }) => {
        const key = category.toLowerCase() as Lowercase<NotificationCategory>;
        acc[key] = Number(count);
        acc['all'] += Number(count);
        return acc;
      },
      { all: 0 } as Record<Lowercase<NotificationCategory> | 'all', number>
    );
    return reduced;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

const validAvatarUrlPrefixes = [
  'https://cdn.discordapp.com/avatars/',
  'https://cdn.discordapp.com/embed/avatars/',
  'https://avatars.githubusercontent.com/u/',
  'https://lh3.googleusercontent.com/a/',
];
const verifyAvatar = (avatar: string) => {
  if (avatar.startsWith('http')) {
    return validAvatarUrlPrefixes.some((prefix) => avatar.startsWith(prefix));
  } else if (isUUID(avatar)) return true; // Is a CF Images UUID
  return false;
};

export const completeOnboardingHandler = async ({
  input,
  ctx,
}: {
  input: UserOnboardingSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id } = ctx.user;
    const onboarding = Flags.addFlag(ctx.user.onboarding, input.step);
    const changed = onboarding !== ctx.user.onboarding;

    switch (input.step) {
      case OnboardingSteps.TOS:
        const { recaptchaToken } = input;
        if (!recaptchaToken) throw throwAuthorizationError('recaptchaToken required');

        const riskScore = await createRecaptchaAssesment({
          token: recaptchaToken,
          recaptchaAction: RECAPTCHA_ACTIONS.COMPLETE_ONBOARDING,
        });

        if (!riskScore || riskScore < 0.5)
          throw throwAuthorizationError(
            'We are unable to complete onboarding right now. Please try again later'
          );

        await dbWrite.user.update({ where: { id }, data: { onboarding } });
        break;
      case OnboardingSteps.Profile:
        await dbWrite.user.update({
          where: { id },
          data: { onboarding, username: input.username, email: input.email },
        });
        break;
      case OnboardingSteps.BrowsingLevels:
        await dbWrite.user.update({
          where: { id },
          data: { onboarding },
        });
        break;
      case OnboardingSteps.Buzz:
        await dbWrite.user.update({ where: { id }, data: { onboarding } });
        if (input.userReferralCode || input.source) {
          await createUserReferral({
            id,
            userReferralCode: input.userReferralCode,
            source: input.source,
            ip: ctx.ip,
          });
        }

        await withRetries(() =>
          createBuzzTransaction({
            fromAccountId: 0,
            toAccountId: ctx.user.id,
            amount: getUserBuzzBonusAmount(ctx.user),
            description: 'Onboarding bonus',
            type: TransactionType.Reward,
            externalTransactionId: `${ctx.user.id}-onboarding-bonus`,
          })
        ).catch(handleLogError);
        break;
    }
    const isComplete = onboarding === OnboardingComplete;
    if (isComplete && changed) onboardingCompletedCounter.inc();
  } catch (e) {
    const err = e as Error;
    if (!err.message.includes('constraint failed')) onboardingErrorCounter.inc();
    if (e instanceof TRPCError) throw e;
    throw throwDbError(e);
  }
};

export const updateUserHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: Partial<UserUpdateInput>;
}) => {
  const {
    id,
    badgeId,
    nameplateId,
    profileDecorationId,
    profileBackgroundId,
    showNsfw,
    username,
    source,
    landingPage,
    userReferralCode,
    profilePicture,
    ...data
  } = input;
  const currentUser = ctx.user;
  if (id !== currentUser.id) throw throwAuthorizationError();
  if (username && !isUsernamePermitted(username)) throw throwBadRequestError('Invalid username');

  if (data.image) {
    const valid = verifyAvatar(data.image);
    if (!valid) throw throwBadRequestError('Invalid avatar URL');
  }

  try {
    const user = await getUserById({ id, select: { profilePictureId: true } });
    if (!user) throw throwNotFoundError(`No user with id ${id}`);

    const payloadCosmeticIds: number[] = [];
    if (badgeId) payloadCosmeticIds.push(badgeId);
    else if (badgeId === null)
      await unequipCosmeticByType({ userId: id, type: CosmeticType.Badge });

    if (nameplateId) payloadCosmeticIds.push(nameplateId);
    else if (nameplateId === null)
      await unequipCosmeticByType({ userId: id, type: CosmeticType.NamePlate });

    if (profileDecorationId) payloadCosmeticIds.push(profileDecorationId);
    else if (profileDecorationId === null)
      await unequipCosmeticByType({ userId: id, type: CosmeticType.ProfileDecoration });

    if (profileBackgroundId) payloadCosmeticIds.push(profileBackgroundId);
    else if (profileBackgroundId === null)
      await unequipCosmeticByType({ userId: id, type: CosmeticType.ProfileBackground });

    const isSettingCosmetics = payloadCosmeticIds.length > 0;

    const updatedUser = await updateUserById({
      id,
      data: {
        ...data,
        username,
        showNsfw,
        profilePicture: profilePicture
          ? {
              connectOrCreate: {
                where: { id: profilePicture.id ?? -1 },
                create: {
                  ...profilePicture,
                  metadata: {
                    ...profilePicture.metadata,
                    profilePicture: true,
                    userId: id,
                    username,
                  },
                  userId: id,
                },
              },
            }
          : undefined,
      },
    });

    // Delete old profilePic and ingest new one
    if (user.profilePictureId && profilePicture && user.profilePictureId !== profilePicture.id) {
      await deleteImageById({ id: user.profilePictureId });
    }

    if (
      profilePicture &&
      updatedUser.profilePictureId &&
      user.profilePictureId !== profilePicture?.id
    ) {
      await ingestImage({
        image: {
          id: updatedUser.profilePictureId,
          url: profilePicture.url,
          type: profilePicture.type,
          height: profilePicture.height,
          width: profilePicture.width,
        },
      });
      await deleteUserProfilePictureCache(id);
    }

    if (isSettingCosmetics) await equipCosmetic({ userId: id, cosmeticId: payloadCosmeticIds });

    if (data.leaderboardShowcase !== undefined) await updateLeaderboardRank({ userIds: id });
    if (userReferralCode || source || landingPage) {
      await createUserReferral({
        id: updatedUser.id,
        userReferralCode,
        source,
        landingPage,
        ip: ctx.ip,
      });
    }

    await usersSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);

    return updatedUser;
  } catch (error) {
    if (error instanceof TRPCError) throw error; // Rethrow the error if it's already a TRCPError
    else throw throwDbError(error); // Otherwise, generate a db error
  }
};

export const deleteUserHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: DeleteUserInput;
}) => {
  const { id } = input;
  const currentUser = ctx.user;
  const canRemoveAsModerator = !isProd && currentUser.isModerator;
  if (id !== currentUser.id && !canRemoveAsModerator) throw throwAuthorizationError();

  try {
    const user = await deleteUser(input);
    if (!user) throw throwNotFoundError(`No user with id ${id}`);

    await ctx.track.userActivity({
      targetUserId: id,
      type: 'Account closure',
    });

    return user;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

type EngagedModelType = ModelEngagementType | 'Recommended';

export const getUserEngagedModelsHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  const { id } = ctx.user;

  try {
    const engagementsCache = await redis.get(`user:${id}:model-engagements`);
    if (engagementsCache) return JSON.parse(engagementsCache) as Record<EngagedModelType, number[]>;

    const engagements = await getUserEngagedModels({ id });
    const recommendedReviews = await getResourceReviewsByUserId({ userId: id, recommended: true });

    // turn array of user.engagedModels into object with `type` as key and array of modelId as value
    const engagedModels = engagements.reduce<Record<EngagedModelType, number[]>>((acc, model) => {
      const { type, modelId } = model;
      if (!acc[type]) acc[type] = [];
      acc[type].push(modelId);
      return acc;
    }, {} as Record<EngagedModelType, number[]>);
    engagedModels.Recommended = recommendedReviews.map((r) => r.modelId).filter(isDefined);

    await redis.set(`user:${id}:model-engagements`, JSON.stringify(engagedModels), {
      EX: 60 * 60 * 24,
    });

    return engagedModels;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

type EngagedModelVersionType = ModelVersionEngagementType | 'Downloaded';

export const getUserEngagedModelVersionsHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const userId = ctx.user.id;
  const versions = await dbRead.modelVersion.findMany({
    where: { modelId: input.id },
    select: { id: true },
  });
  const modelVersionIds = versions.map((x) => x.id);

  try {
    const engagements = await getUserEngagedModelVersions({ userId, modelVersionIds });
    const downloads = await getUserDownloads({ userId, modelVersionIds });

    // turn array of user.engagedModelVersions into object with `type` as key and array of modelVersionId as value
    const engagedModelVersions = engagements.reduce<Record<EngagedModelVersionType, number[]>>(
      (acc, engagement) => {
        const { type, modelVersionId } = engagement;
        if (!acc[type]) acc[type] = [];
        acc[type].push(modelVersionId);
        return acc;
      },
      {} as Record<EngagedModelVersionType, number[]>
    );
    engagedModelVersions.Downloaded = downloads.map((x) => x.modelVersionId);

    return engagedModelVersions;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getCreatorsHandler = async ({ input }: { input: Partial<GetAllSchema> }) => {
  const { limit = DEFAULT_PAGE_SIZE, page, query } = input;
  const { take, skip } = getPagination(limit, page);

  try {
    const results = await getCreators({
      query,
      take,
      skip,
      count: true,
      excludeIds: [-1], // Exclude civitai user
      select: {
        username: true,
        models: { select: { id: true }, where: { status: 'Published' } },
        image: true,
      },
    });

    return getPagingData(results, take, page);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getUserFollowingListHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    const { id: userId } = ctx.user;
    const user = await getUserById({
      id: userId,
      select: {
        engagingUsers: {
          where: { type: 'Follow' },
          select: { targetUser: { select: simpleUserSelect } },
        },
      },
    });

    if (!user) throw throwNotFoundError(`No user with id ${userId}`);

    return user.engagingUsers.map(({ targetUser }) => targetUser);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const getUserListsHandler = async ({ input }: { input: GetByUsernameSchema }) => {
  try {
    const { username } = input;

    const user = await getUserByUsername({ username, select: { createdAt: true } });
    if (!user) throw throwNotFoundError(`No user with username ${username}`);

    const [userFollowing, userFollowers, userHidden] = await Promise.all([
      getUserByUsername({
        username,
        select: {
          _count: { select: { engagingUsers: { where: { type: 'Follow' } } } },
          engagingUsers: {
            select: { targetUser: { select: simpleUserSelect } },
            where: { type: 'Follow' },
          },
        },
      }),
      getUserByUsername({
        username,
        select: {
          _count: { select: { engagedUsers: { where: { type: 'Follow' } } } },
          engagedUsers: {
            select: { user: { select: simpleUserSelect } },
            where: { type: 'Follow' },
          },
        },
      }),
      getUserByUsername({
        username,
        select: {
          _count: { select: { engagingUsers: { where: { type: 'Hide' } } } },
          engagingUsers: {
            select: { targetUser: { select: simpleUserSelect } },
            where: { type: 'Hide' },
          },
        },
      }),
    ]);

    return {
      following: userFollowing?.engagingUsers.map(({ targetUser }) => targetUser) ?? [],
      followingCount: userFollowing?._count.engagingUsers ?? 0,
      followers: userFollowers?.engagedUsers.map(({ user }) => user) ?? [],
      followersCount: userFollowers?._count.engagedUsers ?? 0,
      hidden: userHidden?.engagingUsers.map(({ targetUser }) => targetUser) ?? [],
      hiddenCount: userHidden?._count.engagingUsers ?? 0,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const toggleFollowUserHandler = async ({
  input,
  ctx,
}: {
  input: ToggleFollowUserSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const result = await toggleFollowUser({ ...input, userId });
    if (result) {
      await firstDailyFollowReward.apply({ followingId: input.targetUserId, userId });
      ctx.track
        .userEngagement({
          type: 'Follow',
          targetUserId: input.targetUserId,
        })
        .catch(handleLogError);
    } else {
      ctx.track
        .userEngagement({
          type: 'Delete',
          targetUserId: input.targetUserId,
        })
        .catch(handleLogError);
    }
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getUserHiddenListHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    const { id: userId } = ctx.user;
    //TODO CLEAN UP: Can this just be an array of ids?
    const user = await getUserById({
      id: userId,
      select: {
        engagingUsers: {
          where: { type: 'Hide' },
          select: { targetUser: { select: simpleUserSelect } },
        },
      },
    });

    if (!user) throw throwNotFoundError(`No user with id ${userId}`);

    return user.engagingUsers.map(({ targetUser }) => targetUser);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const toggleHideUserHandler = async ({
  input,
  ctx,
}: {
  input: ToggleFollowUserSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const result = await toggleHideUser({ ...input, userId });
    if (result) {
      await ctx.track.userEngagement({
        type: 'Hide',
        targetUserId: input.targetUserId,
      });
    } else {
      await ctx.track.userEngagement({
        type: 'Delete',
        targetUserId: input.targetUserId,
      });
    }
  } catch (error) {
    throw throwDbError(error);
  }
};

export const toggleHideModelHandler = async ({
  input,
  ctx,
}: {
  input: ToggleModelEngagementInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const result = await toggleModelHide({ ...input, userId });
    if (result) {
      await ctx.track.modelEngagement({
        type: 'Hide',
        modelId: input.modelId,
      });
    } else {
      await ctx.track.modelEngagement({
        type: 'Delete',
        modelId: input.modelId,
      });
    }
    await redis.del(`user:${userId}:model-engagements`);
  } catch (error) {
    throw throwDbError(error);
  }
};

export async function toggleFavoriteHandler({
  input: { modelId, modelVersionId, setTo },
  ctx,
}: {
  input: ToggleFavoriteInput;
  ctx: DeepNonNullable<Context>;
}) {
  const { id: userId, muted } = ctx.user;
  if (muted) return false;

  // Toggle review (on/off)
  const reviewResult = await toggleReview({
    modelId,
    modelVersionId,
    userId,
    setTo,
  });

  // If favoriting, also bookmark and notify
  if (setTo) {
    // Toggle notifications
    await toggleModelEngagement({
      modelId,
      type: ModelEngagementType.Notify,
      userId,
      setTo,
    });

    // Toggle to bookmark collection
    await toggleBookmarked({
      type: 'Model',
      entityId: modelId,
      userId,
      setTo,
    });
  } else {
    const userModelReviews = await getUserResourceReview({ userId, modelId });

    // Remove it from bookmark collection if no reviews
    if (!userModelReviews?.length)
      // Toggle to bookmark collection
      await toggleBookmarked({
        type: 'Model',
        entityId: modelId,
        userId,
        setTo,
      });
  }

  await redis.del(`user:${userId}:model-engagements`);

  return reviewResult;
}

export const toggleNotifyModelHandler = async ({
  input,
  ctx,
}: {
  input: ToggleModelEngagementInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const result = input.type
      ? await toggleModelEngagement({ modelId: input.modelId, type: input.type, userId })
      : await toggleModelNotify({ ...input, userId });

    if (result) {
      await ctx.track.modelEngagement({
        type: 'Notify',
        modelId: input.modelId,
      });
    } else {
      await ctx.track.modelEngagement({
        type: 'Delete',
        modelId: input.modelId,
      });
    }
    await redis.del(`user:${userId}:model-engagements`);

    return result;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getLeaderboardHandler = async ({ input }: { input: GetAllSchema }) => {
  const { limit: take = DEFAULT_PAGE_SIZE, query, page } = input;
  const skip = page ? (page - 1) * take : undefined;

  try {
    const { items } = await getCreators({
      query,
      take,
      skip,
      excludeIds: [-1], // Exclude civitai user
      select: {
        id: true,
        image: true,
        username: true,
        links: {
          select: {
            url: true,
            type: true,
          },
        },
        stats: {
          select: {
            ratingMonth: true,
            ratingCountMonth: true,
            downloadCountMonth: true,
            favoriteCountMonth: true,
            thumbsUpCountMonth: true,
            uploadCountMonth: true,
            answerCountMonth: true,
          },
        },
        cosmetics: {
          where: { equippedAt: { not: null } },
          select: {
            cosmetic: {
              select: {
                id: true,
                data: true,
                type: true,
                source: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: { rank: { leaderboardRank: 'asc' } },
    });

    return items;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getUserTagsHandler = async ({
  input,
  ctx,
}: {
  input?: GetUserTagsSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id } = ctx.user;
    const user = await getUserById({
      id,
      select: {
        tagsEngaged: {
          where: input ? { type: input.type } : undefined,
          select: {
            tag: { select: { id: true, name: true } },
            type: !!input?.type ? true : undefined,
          },
        },
      },
    });
    if (!user) throw throwNotFoundError(`No user with id ${id}`);

    return user.tagsEngaged.map(({ tag }) => tag);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const toggleMuteHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  if (!ctx.user.isModerator) throw throwAuthorizationError();

  const { id } = input;
  const user = await getUserById({ id, select: { muted: true } });
  if (!user) throw throwNotFoundError(`No user with id ${id}`);

  const updatedUser = await updateUserById({ id, data: { muted: !user.muted } });
  await invalidateSession(id);

  await ctx.track.userActivity({
    type: user.muted ? 'Unmuted' : 'Muted',
    targetUserId: id,
  });

  return updatedUser;
};

export const toggleBanHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  if (!ctx.user.isModerator) throw throwAuthorizationError();

  const updatedUser = await toggleBan(input);

  await ctx.track.userActivity({
    type: updatedUser.bannedAt ? 'Banned' : 'Unbanned',
    targetUserId: updatedUser.id,
  });

  return updatedUser;
};

export const getUserCosmeticsHandler = async ({
  input,
  ctx,
}: {
  input?: GetUserCosmeticsSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const { equipped = false } = input || {};
    const user = await getUserCosmetics({ equipped, userId });
    if (!user) throw throwNotFoundError(`No user with id ${userId}`);

    const inUseCosmeticEntities = user.cosmetics
      .map(({ equippedToId, equippedToType }) =>
        equippedToId && equippedToType
          ? { entityType: equippedToType, entityId: equippedToId }
          : null
      )
      .filter(isDefined);
    const coverImages = await getEntityCoverImage({ entities: inUseCosmeticEntities });

    const cosmetics = user.cosmetics.reduce(
      (acc, { obtainedAt, equippedToId, equippedToType, claimKey, cosmetic, forId, forType }) => {
        const { type, data, ...rest } = cosmetic;
        const sharedData = {
          ...rest,
          type,
          obtainedAt,
          claimKey,
          inUse: !!equippedToId,
          entityImage: coverImages.find(
            (x) => x.entityId === equippedToId && x.entityType === equippedToType
          ),
          forId,
          forType,
        };

        if (type === CosmeticType.Badge)
          acc.badges.push({ ...sharedData, data: data as BadgeCosmetic['data'] });
        else if (type === CosmeticType.NamePlate)
          acc.nameplates.push({ ...sharedData, data: data as NamePlateCosmetic['data'] });
        else if (type === CosmeticType.ProfileDecoration)
          acc.profileDecorations.push({
            ...sharedData,
            data: data as ContentDecorationCosmetic['data'],
          });
        else if (type === CosmeticType.ContentDecoration)
          acc.contentDecorations.push({
            ...sharedData,
            data: data as ContentDecorationCosmetic['data'],
          });
        else if (type === CosmeticType.ProfileBackground)
          acc.profileBackground.push({
            ...sharedData,
            data: data as ProfileBackgroundCosmetic['data'],
          });

        return acc;
      },
      {
        badges: [] as WithClaimKey<BadgeCosmetic>[],
        nameplates: [] as WithClaimKey<NamePlateCosmetic>[],
        profileDecorations: [] as WithClaimKey<ContentDecorationCosmetic>[],
        profileBackground: [] as WithClaimKey<ProfileBackgroundCosmetic>[],
        contentDecorations: [] as WithClaimKey<ContentDecorationCosmetic>[],
      }
    );

    return cosmetics;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const toggleArticleEngagementHandler = async ({
  input,
  ctx,
}: {
  input: ToggleUserArticleEngagementsInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const on = await toggleUserArticleEngagement({ ...input, userId: ctx.user.id });
    // Not awaiting here to avoid slowing down the response
    ctx.track
      .articleEngagement({
        ...input,
        type: on ? input.type : `Delete${input.type}`,
      })
      .catch(handleLogError);

    return on;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const toggleBountyEngagementHandler = async ({
  input,
  ctx,
}: {
  input: ToggleUserBountyEngagementsInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const on = await toggleUserBountyEngagement({ ...input, userId: ctx.user.id });

    // Not awaiting here to avoid slowing down the response
    ctx.track
      .bountyEngagement({
        ...input,
        type: on ? input.type : `Delete${input.type}`,
      })
      .catch(handleLogError);

    return on;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const reportProhibitedRequestHandler = async ({
  input,
  ctx,
}: {
  input: ReportProhibitedRequestInput;
  ctx: DeepNonNullable<Context>;
}) => {
  await ctx.track.prohibitedRequest({
    prompt: input.prompt ?? '{error capturing prompt}',
    source: input.source,
  });
  if (ctx.user.isModerator) return false;

  try {
    const userId = ctx.user.id;
    const countRes = await clickhouse?.query({
      query: `
        SELECT
          COUNT(*) as count
        FROM prohibitedRequests
        WHERE userId = ${userId} AND time > subtractHours(now(), 24);
      `,
      format: 'JSONEachRow',
    });
    const count = ((await countRes?.json()) as [{ count: number }])?.[0]?.count ?? 0;
    const limit =
      constants.imageGeneration.requestBlocking.muted -
      constants.imageGeneration.requestBlocking.notified;
    if (count >= limit) {
      await updateUserById({ id: userId, data: { muted: true } });
      await invalidateSession(userId);

      await ctx.track.userActivity({
        type: 'Muted',
        targetUserId: userId,
      });

      return true;
    }
  } catch (error) {
    throw new TRPCError({
      message: 'Error checking prohibited request count',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }

  return false;
};

export const userByReferralCodeHandler = async ({ input }: { input: UserByReferralCodeSchema }) => {
  try {
    return await userByReferralCode(input);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const userRewardDetailsHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    // TODO.Optimization: This will make multiple requests to redis, we could probably do it in one and make this faster. This will get slower as we add more Active rewards.
    const rewardDetails = await Promise.all(
      Object.values(rewards)
        .filter((x) => x.visible)
        .map((x) => x.getUserRewardDetails(ctx.user.id))
    );

    // sort by `onDemand` first
    return orderBy(rewardDetails, ['onDemand', 'awardAmount'], ['desc', 'asc']);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const claimCosmeticHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id } = input;
    const { id: userId } = ctx.user;
    const cosmetic = await claimCosmetic({ id, userId });
    if (!cosmetic) throw throwNotFoundError(`No cosmetic with id ${id}`);

    // TODO: track with clickhouse?

    return cosmetic;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getUserPaymentMethodsHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    let { customerId } = ctx.user;

    if (!ctx.user.email) {
      throw throwBadRequestError('User must have an email to get payment methods');
    }

    if (!customerId) {
      customerId = await createCustomer({
        ...ctx.user,
        email: ctx.user.email as string,
      });
    }

    const paymentMethods = getCustomerPaymentMethods(customerId);

    return paymentMethods;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteUserPaymentMethodHandler = async ({
  input,
  ctx,
}: {
  input: PaymentMethodDeleteInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return deleteCustomerPaymentMethod({
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
      ...input,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

const defaultToggleableFeatures = toggleableFeatures.reduce(
  (acc, feature) => ({ ...acc, [feature.key]: feature.default }),
  {} as FeatureAccess
);
export const getUserFeatureFlagsHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    const { id } = ctx.user;
    const { features = {} } = await getUserSettings(id);

    return {
      ...defaultToggleableFeatures,
      ...features,
    } as FeatureAccess;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const toggleUserFeatureFlagHandler = async ({
  input,
  ctx,
}: {
  input: ToggleFeatureInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id } = ctx.user;
    const { features = {}, ...restSettings } = await getUserSettings(id);

    const updatedFeatures: Partial<FeatureAccess> = {
      ...features,
      [input.feature]: isDefined(features[input.feature])
        ? input.value ?? !features[input.feature]
        : input.value ?? !defaultToggleableFeatures[input.feature],
    };

    await setUserSetting(id, { ...restSettings, features: updatedFeatures });

    return updatedFeatures;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getUserSettingsHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    const { id } = ctx.user;
    const settings = await getUserSettings(id);

    // Limits it to the input type
    return settings as UserSettingsSchema;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const setUserSettingHandler = async ({
  input,
  ctx,
}: {
  input: SetUserSettingsInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id } = ctx.user;
    const { ...restSettings } = await getUserSettings(id);
    const newSettings = { ...restSettings, ...input };

    await setUserSetting(id, newSettings);
    return newSettings;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const dismissAlertHandler = async ({
  input,
  ctx,
}: {
  input: { alertId: string };
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id } = ctx.user;
    const { dismissedAlerts = [] } = await getUserSettings(id);
    dismissedAlerts.push(input.alertId);

    await setUserSetting(id, { dismissedAlerts });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getUserBookmarkCollectionsHandler = async ({
  ctx,
}: {
  ctx: DeepNonNullable<Context>;
}) => {
  return getUserBookmarkCollections({
    userId: ctx.user.id,
  });
};

export const getUserPurchasedRewardsHandler = async ({
  ctx,
}: {
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return getUserPurchasedRewards({
      userId: ctx.user.id,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};
