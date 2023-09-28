import { CosmeticType, ModelEngagementType, ModelVersionEngagementType } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { Context } from '~/server/createContext';
import {
  getCreators,
  getUserByUsername,
  getUserCreator,
  getUserEngagedModels,
  getUserEngagedModelVersions,
  getUserTags,
  getUserUnreadNotificationsCount,
  toggleBlockedTag,
  toggleFollowUser,
  toggleHideUser,
  toggleModelHide,
  toggleModelFavorite,
  getUserCosmetics,
  acceptTOS,
  completeOnboarding,
  isUsernamePermitted,
  toggleUserArticleEngagement,
  updateLeaderboardRank,
  toggleBan,
  toggleUserBountyEngagement,
  userByReferralCode,
  createUserReferral,
} from '~/server/services/user.service';
import { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import {
  GetAllUsersInput,
  UserUpdateInput,
  GetUserByUsernameSchema,
  ToggleFollowUserSchema,
  GetByUsernameSchema,
  DeleteUserInput,
  ToggleBlockedTagSchema,
  GetUserTagsSchema,
  BatchBlockTagsSchema,
  ToggleModelEngagementInput,
  GetUserCosmeticsSchema,
  ToggleUserArticleEngagementsInput,
  ToggleUserBountyEngagementsInput,
  ReportProhibitedRequestInput,
  UserByReferralCodeSchema,
} from '~/server/schema/user.schema';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { deleteUser, getUserById, getUsers, updateUserById } from '~/server/services/user.service';
import {
  handleTrackError,
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { invalidateSession } from '~/server/utils/session-helpers';
import { BadgeCosmetic, NamePlateCosmetic } from '~/server/selectors/cosmetic.selector';
import { isUUID } from '~/utils/string-helpers';
import { refreshAllHiddenForUser } from '~/server/services/user-cache.service';
import { dbWrite } from '~/server/db/client';
import { cancelSubscription } from '~/server/services/stripe.service';
import { redis } from '~/server/redis/client';
import { clickhouse } from '~/server/clickhouse/client';
import { constants } from '~/server/common/constants';

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

    if (!user) {
      throw throwNotFoundError(`No user with id ${input.id}`);
    }

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
    const user = await getUserById({
      id,
      select: { notificationSettings: { select: { id: true, type: true, disabledAt: true } } },
    });

    if (!user) throw throwNotFoundError(`No user with id ${id}`);

    return user.notificationSettings;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const checkUserNotificationsHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  const { id } = ctx.user;

  try {
    const user = await getUserUnreadNotificationsCount({ id });
    if (!user) throw throwNotFoundError(`No user with id ${id}`);

    return { count: user._count.notifications };
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

export const acceptTOSHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    const { id } = ctx.user;
    await acceptTOS({ id });
  } catch (e) {
    throw throwDbError(e);
  }
};

export const completeOnboardingHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    const { id } = ctx.user;
    await completeOnboarding({ id });
  } catch (e) {
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
  const { id, badgeId, nameplateId, showNsfw, username, source, userReferralCode, ...data } = input;
  const currentUser = ctx.user;
  if (id !== currentUser.id) throw throwAuthorizationError();
  if (username && !isUsernamePermitted(username)) throw throwBadRequestError('Invalid username');

  if (data.image) {
    const valid = verifyAvatar(data.image);
    if (!valid) throw throwBadRequestError('Invalid avatar URL');
  }

  const isSettingCosmetics = badgeId !== undefined && nameplateId !== undefined;

  try {
    const payloadCosmeticIds: number[] = [];
    if (badgeId) payloadCosmeticIds.push(badgeId);
    if (nameplateId) payloadCosmeticIds.push(nameplateId);
    const updatedUser = await updateUserById({
      id,
      data: {
        ...data,
        username,
        showNsfw,
        cosmetics: !isSettingCosmetics
          ? undefined
          : {
              updateMany: {
                where: { equippedAt: { not: null } },
                data: { equippedAt: null },
              },
              update: payloadCosmeticIds.map((cosmeticId) => ({
                where: { userId_cosmeticId: { userId: id, cosmeticId } },
                data: { equippedAt: new Date() },
              })),
            },
      },
    });

    if (data.leaderboardShowcase !== undefined) await updateLeaderboardRank(id);
    if (userReferralCode || source) {
      await createUserReferral({
        id: updatedUser.id,
        userReferralCode,
        source,
      });
    }
    if (!updatedUser) throw throwNotFoundError(`No user with id ${id}`);
    if (ctx.user.showNsfw !== showNsfw) await refreshAllHiddenForUser({ userId: id });

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
  if (id !== currentUser.id) throw throwAuthorizationError();

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

export const getUserEngagedModelsHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  const { id } = ctx.user;

  try {
    const engagementsCache = await redis.get(`user:${id}:model-engagements`);
    if (engagementsCache)
      return JSON.parse(engagementsCache) as Record<ModelEngagementType, number[]>;

    const engagements = await getUserEngagedModels({ id });

    // turn array of user.engagedModels into object with `type` as key and array of modelId as value
    const engagedModels = engagements.reduce<Record<ModelEngagementType, number[]>>(
      (acc, model) => {
        const { type, modelId } = model;
        if (!acc[type]) acc[type] = [];
        acc[type].push(modelId);
        return acc;
      },
      {} as Record<ModelEngagementType, number[]>
    );

    await redis.set(`user:${id}:model-engagements`, JSON.stringify(engagedModels), {
      EX: 60 * 60 * 24,
    });

    return engagedModels;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getUserEngagedModelVersionsHandler = async ({
  ctx,
}: {
  ctx: DeepNonNullable<Context>;
}) => {
  const { id } = ctx.user;

  try {
    const engagements = await getUserEngagedModelVersions({ id });

    // turn array of user.engagedModelVersions into object with `type` as key and array of modelId as value
    const engagedModelVersions = engagements.reduce<Record<ModelVersionEngagementType, number[]>>(
      (acc, engagement) => {
        const { type, modelVersionId } = engagement;
        if (!acc[type]) acc[type] = [];
        acc[type].push(modelVersionId);
        return acc;
      },
      {} as Record<ModelVersionEngagementType, number[]>
    );

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
      ctx.track.userEngagement({
        type: 'Follow',
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

export const toggleFavoriteModelHandler = async ({
  input,
  ctx,
}: {
  input: ToggleModelEngagementInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const result = await toggleModelFavorite({ ...input, userId });
    if (result) {
      await ctx.track.modelEngagement({
        type: 'Favorite',
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

export const toggleBlockedTagHandler = async ({
  input,
  ctx,
}: {
  input: ToggleBlockedTagSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const isHidden = await toggleBlockedTag({ ...input, userId });
    ctx.track.tagEngagement({
      type: isHidden ? 'Hide' : 'Allow',
      tagId: input.tagId,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const batchBlockTagsHandler = async ({
  input,
  ctx,
}: {
  input: BatchBlockTagsSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const { tagIds } = input;
    const currentBlockedTags = await getUserTags({ userId, type: 'Hide' });
    const blockedTagIds = currentBlockedTags.map(({ tagId }) => tagId);
    const tagsToRemove = blockedTagIds.filter((id) => !tagIds.includes(id));

    const updatedUser = await updateUserById({
      id: userId,
      data: {
        tagsEngaged: {
          deleteMany: { userId, tagId: { in: tagsToRemove } },
          upsert: tagIds.map((tagId) => ({
            where: { userId_tagId: { userId, tagId } },
            update: { type: 'Hide' },
            create: { type: 'Hide', tagId },
          })),
        },
      },
    });
    if (!updatedUser) throw throwNotFoundError(`No user with id ${userId}`);

    return updatedUser;
  } catch (error) {
    throw throwDbError(error);
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

    const cosmetics = user.cosmetics.reduce(
      (acc, { obtainedAt, cosmetic }) => {
        const { type, data, ...rest } = cosmetic;
        if (type === CosmeticType.Badge)
          acc.badges.push({ ...rest, data: data as BadgeCosmetic['data'], obtainedAt });
        else if (type === CosmeticType.NamePlate)
          acc.nameplates.push({ ...rest, data: data as NamePlateCosmetic['data'], obtainedAt });

        return acc;
      },
      { badges: [] as BadgeCosmetic[], nameplates: [] as NamePlateCosmetic[] }
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
    if (on) await ctx.track.articleEngagement(input);
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
      .catch(handleTrackError);

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
  await ctx.track.prohibitedRequest(input);
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
