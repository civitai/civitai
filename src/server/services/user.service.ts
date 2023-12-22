import {
  ToggleUserArticleEngagementsInput,
  UserByReferralCodeSchema,
} from './../schema/user.schema';
import {
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  ArticleEngagementType,
  BountyEngagementType,
  CosmeticSource,
  CosmeticType,
  ModelEngagementType,
  OnboardingStep,
  Prisma,
  SearchIndexUpdateQueueAction,
  TagEngagementType,
} from '@prisma/client';

import { dbWrite, dbRead } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  DeleteUserInput,
  GetAllUsersInput,
  GetByUsernameSchema,
  GetUserCosmeticsSchema,
  ToggleBlockedTagSchema,
  ToggleUserBountyEngagementsInput,
} from '~/server/schema/user.schema';
import { invalidateSession } from '~/server/utils/session-helpers';
import { env } from '~/env/server.mjs';
import {
  refreshAllHiddenForUser,
  refreshHiddenModelsForUser,
  refreshHiddenUsersForUser,
} from '~/server/services/user-cache.service';
import { cancelSubscription } from '~/server/services/stripe.service';
import { playfab } from '~/server/playfab/client';
import blockedUsernames from '~/utils/blocklist-username.json';
import { getSystemPermissions } from '~/server/services/system-cache';
import {
  articlesSearchIndex,
  bountiesSearchIndex,
  collectionsSearchIndex,
  imagesSearchIndex,
  modelsSearchIndex,
  usersSearchIndex,
} from '~/server/search-index';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { articleMetrics, imageMetrics, userMetrics } from '~/server/metrics';
import { refereeCreatedReward, userReferredReward } from '~/server/rewards';
import { handleLogError } from '~/server/utils/errorHandling';
import { isCosmeticAvailable } from '~/server/services/cosmetic.service';
import { ProfileImage } from '../selectors/image.selector';
import { bustCachedArray, cachedObject } from '~/server/utils/cache-helpers';
// import { createFeaturebaseToken } from '~/server/featurebase/featurebase';

export const getUserCreator = async ({
  leaderboardId,
  ...where
}: {
  username?: string;
  id?: number;
  leaderboardId?: string;
}) => {
  return dbRead.user.findFirst({
    where: {
      ...where,
      deletedAt: null,
      AND: [{ id: { not: -1 } }, { username: { not: 'civitai' } }],
    },
    select: {
      id: true,
      image: true,
      username: true,
      muted: true,
      bannedAt: true,
      createdAt: true,
      links: {
        select: {
          url: true,
          type: true,
        },
      },
      stats: {
        select: {
          ratingAllTime: true,
          ratingCountAllTime: true,
          downloadCountAllTime: true,
          favoriteCountAllTime: true,
          followerCountAllTime: true,
        },
      },
      rank: {
        select: {
          leaderboardRank: true,
          leaderboardId: true,
          leaderboardTitle: true,
          leaderboardCosmetic: true,
        },
      },
      cosmetics: {
        where: { equippedAt: { not: null } },
        select: {
          data: true,
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
      _count: {
        select: {
          models: {
            where: { status: 'Published' },
          },
        },
      },
    },
  });
};

export const getUsers = ({ limit, query, email, ids }: GetAllUsersInput) => {
  return dbRead.$queryRaw<{ id: number; username: string }[]>`
    SELECT id, username
    FROM "User"
    WHERE
      ${ids && ids.length > 0 ? Prisma.sql`id IN (${Prisma.join(ids)})` : Prisma.sql`TRUE`}
      AND ${query ? Prisma.sql`username LIKE ${query + '%'}` : Prisma.sql`TRUE`}
      AND ${email ? Prisma.sql`email ILIKE ${email + '%'}` : Prisma.sql`TRUE`}
      AND "deletedAt" IS NULL
      AND "id" != -1
    ORDER BY LENGTH(username) ASC
    LIMIT ${limit}
  `;
};

export const getUserById = <TSelect extends Prisma.UserSelect = Prisma.UserSelect>({
  id,
  select,
}: GetByIdInput & { select: TSelect }) => {
  return dbRead.user.findUnique({
    where: { id },
    select,
  });
};

export const getUserByUsername = <TSelect extends Prisma.UserSelect = Prisma.UserSelect>({
  username,
  select,
}: GetByUsernameSchema & { select: TSelect }) => {
  return dbRead.user.findFirst({
    where: { username, deletedAt: null, id: { not: -1 } },
    select,
  });
};

export const isUsernamePermitted = (username: string) => {
  const lower = username.toLowerCase();
  const isPermitted = !(
    blockedUsernames.partial.some((x) => lower.includes(x)) ||
    blockedUsernames.exact.some((x) => lower === x)
  );

  return isPermitted;
};

export const updateUserById = async ({
  id,
  data,
}: {
  id: number;
  data: Prisma.UserUpdateInput;
}) => {
  const user = await dbWrite.user.update({ where: { id }, data });
  await usersSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);

  return user;
};

export const acceptTOS = ({ id }: { id: number }) => {
  return dbWrite.user.update({
    where: { id },
    data: { tos: true },
  });
};

// export const completeOnboarding = async ({ id }: { id: number }) => {
//   return dbWrite.user.update({
//     where: { id },
//     data: { onboarded: true },
//   });
// };

export const updateOnboardingSteps = async ({
  id,
  steps,
}: {
  id: number;
  steps: OnboardingStep[];
}) => {
  return dbWrite.user.update({
    where: { id },
    data: { onboardingSteps: steps },
  });
};

export const getUserEngagedModels = ({ id }: { id: number }) => {
  return dbRead.modelEngagement.findMany({
    where: { userId: id },
    select: { modelId: true, type: true },
  });
};

export const getUserEngagedModelVersions = ({ id }: { id: number }) => {
  return dbRead.modelVersionEngagement.findMany({
    where: { userId: id },
    select: { modelVersionId: true, type: true },
  });
};

export const getUserEngagedModelByModelId = ({
  userId,
  modelId,
}: {
  userId: number;
  modelId: number;
}) => {
  return dbRead.modelEngagement.findUnique({ where: { userId_modelId: { userId, modelId } } });
};

export const getUserTags = ({ userId, type }: { userId: number; type?: TagEngagementType }) => {
  return dbRead.tagEngagement.findMany({ where: { userId, type } });
};

export const getCreators = async <TSelect extends Prisma.UserSelect>({
  query,
  take,
  skip,
  select,
  orderBy,
  excludeIds = [],
  count = false,
}: {
  select: TSelect;
  query?: string;
  take?: number;
  skip?: number;
  count?: boolean;
  orderBy?: Prisma.UserFindManyArgs['orderBy'];
  excludeIds?: number[];
}) => {
  const where: Prisma.UserWhereInput = {
    username: query ? { contains: query } : undefined,
    models: { some: {} },
    id: excludeIds.length ? { notIn: excludeIds } : undefined,
    deletedAt: null,
  };
  const items = await dbRead.user.findMany({
    take,
    skip,
    select,
    where,
    orderBy,
  });

  if (count) {
    const count = await dbRead.user.count({ where });
    return { items, count };
  }

  return { items };
};

export const toggleModelEngagement = async ({
  userId,
  modelId,
  type,
}: {
  userId: number;
  modelId: number;
  type: ModelEngagementType;
}) => {
  const engagement = await dbWrite.modelEngagement.findUnique({
    where: { userId_modelId: { userId, modelId } },
    select: { type: true },
  });

  if (engagement) {
    if (engagement.type === type)
      await dbWrite.modelEngagement.delete({
        where: { userId_modelId: { userId, modelId } },
      });
    else if (engagement.type !== type)
      await dbWrite.modelEngagement.update({
        where: { userId_modelId: { userId, modelId } },
        data: { type, createdAt: new Date() },
      });

    return engagement.type !== type;
  }

  await dbWrite.modelEngagement.create({ data: { type, modelId, userId } });
  if (type === 'Hide') {
    await refreshHiddenModelsForUser({ userId });
    // await playfab.trackEvent(userId, { eventName: 'user_hide_model', modelId });
  } else if (type === 'Favorite') {
    // await playfab.trackEvent(userId, { eventName: 'user_favorite_model', modelId });
  }
  return true;
};

export const toggleModelFavorite = async ({
  userId,
  modelId,
}: {
  userId: number;
  modelId: number;
}) => toggleModelEngagement({ userId, modelId, type: 'Favorite' });

export const toggleModelHide = async ({ userId, modelId }: { userId: number; modelId: number }) =>
  toggleModelEngagement({ userId, modelId, type: 'Hide' });

export const toggleFollowUser = async ({
  userId,
  targetUserId,
}: {
  userId: number;
  targetUserId: number;
}) => {
  const engagement = await dbWrite.userEngagement.findUnique({
    where: { userId_targetUserId: { targetUserId, userId } },
    select: { type: true },
  });

  if (engagement) {
    if (engagement.type === 'Follow')
      await dbWrite.userEngagement.delete({
        where: { userId_targetUserId: { userId, targetUserId } },
      });
    else if (engagement.type === 'Hide')
      await dbWrite.userEngagement.update({
        where: { userId_targetUserId: { userId, targetUserId } },
        data: { type: 'Follow' },
      });

    return false;
  }

  await dbWrite.userEngagement.create({ data: { type: 'Follow', targetUserId, userId } });
  await playfab.trackEvent(userId, { eventName: 'user_follow_user', userId: targetUserId });
  return true;
};

export const toggleHideUser = async ({
  userId,
  targetUserId,
}: {
  userId: number;
  targetUserId: number;
}) => {
  const engagement = await dbWrite.userEngagement.findUnique({
    where: { userId_targetUserId: { targetUserId, userId } },
    select: { type: true },
  });

  if (engagement) {
    if (engagement.type === 'Hide')
      await dbWrite.userEngagement.delete({
        where: { userId_targetUserId: { userId, targetUserId } },
      });
    else if (engagement.type === 'Follow')
      await dbWrite.userEngagement.update({
        where: { userId_targetUserId: { userId, targetUserId } },
        data: { type: 'Hide' },
      });

    return false;
  }

  await dbWrite.userEngagement.create({ data: { type: 'Hide', targetUserId, userId } });
  await playfab.trackEvent(userId, { eventName: 'user_hide_user', userId: targetUserId });
  await refreshHiddenUsersForUser({ userId });
  return true;
};

export const deleteUser = async ({ id, username, removeModels }: DeleteUserInput) => {
  const user = await dbWrite.user.findFirst({
    where: { username, id },
    select: { id: true },
  });
  if (!user) throw throwNotFoundError('Could not find user');

  const modelData: Prisma.ModelUpdateManyArgs['data'] = removeModels
    ? { deletedAt: new Date(), status: 'Deleted' }
    : { userId: -1 };

  const result = await dbWrite.$transaction([
    dbWrite.model.updateMany({ where: { userId: user.id }, data: modelData }),
    dbWrite.account.deleteMany({ where: { userId: user.id } }),
    dbWrite.session.deleteMany({ where: { userId: user.id } }),
    dbWrite.user.update({
      where: { id: user.id },
      data: { deletedAt: new Date(), email: null, username: null },
    }),
  ]);

  await usersSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);

  await invalidateSession(id);

  // Cancel their subscription
  await cancelSubscription({ userId: user.id });

  return result;
};

export const toggleBlockedTag = async ({
  tagId,
  userId,
}: ToggleBlockedTagSchema & { userId: number }) => {
  const matchedTag = await dbWrite.tagEngagement.findUnique({
    where: { userId_tagId: { userId, tagId } },
    select: { type: true },
  });

  let isHidden = false;
  if (matchedTag) {
    if (matchedTag.type === 'Hide')
      await dbWrite.tagEngagement.delete({
        where: { userId_tagId: { userId, tagId } },
      });
    else if (matchedTag.type === 'Follow')
      await dbWrite.tagEngagement.update({
        where: { userId_tagId: { userId, tagId } },
        data: { type: 'Hide' },
      });
  } else {
    await dbWrite.tagEngagement.create({ data: { userId, tagId, type: 'Hide' } });
    isHidden = true;
  }
  await refreshAllHiddenForUser({ userId });
  return isHidden;
};

export const updateAccountScope = async ({
  providerAccountId,
  provider,
  scope,
}: {
  providerAccountId: string;
  provider: string;
  scope?: string;
}) => {
  if (!scope) return;

  const account = await dbWrite.account.findUnique({
    where: { provider_providerAccountId: { provider, providerAccountId } },
    select: { id: true, scope: true },
  });
  if (account && !!account.scope) {
    const currentScope = account.scope.split(' ');
    const hasNewScope = scope?.split(' ').some((s) => !currentScope.includes(s));
    if (hasNewScope) await dbWrite.account.update({ where: { id: account.id }, data: { scope } });
  }
};

export const getSessionUser = async ({ userId, token }: { userId?: number; token?: string }) => {
  if (!userId && !token) return undefined;
  const where: Prisma.UserWhereInput = { deletedAt: null };
  if (userId) where.id = userId;
  else if (token) where.keys = { some: { key: token } };

  const user = await dbWrite.user.findFirst({
    where,
    include: {
      subscription: { select: { status: true, product: { select: { metadata: true } } } },
      referral: { select: { id: true } },
      profilePicture: {
        select: {
          id: true,
          url: true,
          nsfw: true,
          hash: true,
          userId: true,
        },
      },
    },
  });
  if (!user) return undefined;

  const { subscription, profilePicture, profilePictureId, ...rest } = user;
  const tier: string | undefined =
    subscription && ['active', 'trialing'].includes(subscription.status)
      ? (subscription.product.metadata as any)[env.STRIPE_METADATA_KEY]
      : undefined;

  const permissions: string[] = [];
  const systemPermissions = await getSystemPermissions();
  for (const [key, value] of Object.entries(systemPermissions)) {
    if (value.includes(user.id)) permissions.push(key);
  }

  // let feedbackToken: string | undefined;
  // if (!!user.username && !!user.email)
  //   feedbackToken = createFeaturebaseToken(user as { username: string; email: string });

  return {
    ...rest,
    image: profilePicture?.url ?? rest.image,
    tier,
    permissions,
    // feedbackToken,
  };
};

export const removeAllContent = async ({ id }: { id: number }) => {
  const models = await dbRead.model.findMany({ where: { userId: id }, select: { id: true } });
  const images = await dbRead.image.findMany({ where: { userId: id }, select: { id: true } });
  const articles = await dbRead.article.findMany({ where: { userId: id }, select: { id: true } });
  const collections = await dbRead.collection.findMany({
    where: { userId: id },
    select: { id: true },
  });
  const bounties = await dbRead.collection.findMany({
    where: { userId: id },
    select: { id: true },
  });

  const res = await dbWrite.$transaction([
    dbWrite.model.deleteMany({ where: { userId: id } }),
    dbWrite.comment.deleteMany({ where: { userId: id } }),
    dbWrite.commentV2.deleteMany({ where: { userId: id } }),
    dbWrite.resourceReview.deleteMany({ where: { userId: id } }),
    dbWrite.post.deleteMany({ where: { userId: id } }),
    dbWrite.image.deleteMany({ where: { userId: id } }),
    dbWrite.article.deleteMany({ where: { userId: id } }),
    dbWrite.userProfile.deleteMany({ where: { userId: id } }),
    dbWrite.userLink.deleteMany({ where: { userId: id } }),
    dbWrite.question.deleteMany({ where: { userId: id } }),
    dbWrite.answer.deleteMany({ where: { userId: id } }),
    dbWrite.collection.deleteMany({ where: { userId: id } }),
    dbWrite.bounty.deleteMany({ where: { userId: id } }),
    dbWrite.bountyEntry.deleteMany({
      where: { userId: id, benefactors: { none: {} } },
    }),
    dbWrite.imageReaction.deleteMany({ where: { userId: id } }),
    dbWrite.articleReaction.deleteMany({ where: { userId: id } }),
    dbWrite.commentReaction.deleteMany({ where: { userId: id } }),
    dbWrite.commentV2Reaction.deleteMany({ where: { userId: id } }),
  ]);

  await modelsSearchIndex.queueUpdate(
    models.map((m) => ({ id: m.id, action: SearchIndexUpdateQueueAction.Delete }))
  );
  await imagesSearchIndex.queueUpdate(
    images.map((i) => ({ id: i.id, action: SearchIndexUpdateQueueAction.Delete }))
  );
  await articlesSearchIndex.queueUpdate(
    articles.map((a) => ({ id: a.id, action: SearchIndexUpdateQueueAction.Delete }))
  );
  await collectionsSearchIndex.queueUpdate(
    collections.map((c) => ({ id: c.id, action: SearchIndexUpdateQueueAction.Delete }))
  );
  await bountiesSearchIndex.queueUpdate(
    bounties.map((c) => ({ id: c.id, action: SearchIndexUpdateQueueAction.Delete }))
  );
  await usersSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);

  await userMetrics.queueUpdate(id);
  await imageMetrics.queueUpdate(images.map((i) => i.id));
  await articleMetrics.queueUpdate(articles.map((a) => a.id));

  return res;
};

export const getUserCosmetics = ({
  userId,
  equipped,
}: GetUserCosmeticsSchema & { userId: number }) => {
  return dbRead.user.findUnique({
    where: { id: userId },
    select: {
      cosmetics: {
        where: equipped ? { equippedAt: { not: null } } : undefined,
        select: {
          obtainedAt: true,
          cosmetic: {
            select: {
              id: true,
              name: true,
              description: true,
              type: true,
              source: true,
              data: true,
            },
          },
        },
      },
    },
  });
};

type UserCosmeticLookup = {
  userId: number;
  cosmetics: {
    cosmetic: {
      id: number;
      name: string;
      type: CosmeticType;
      data: Prisma.JsonValue;
      source: CosmeticSource;
    };
    data: Prisma.JsonValue;
  }[];
};
export async function getCosmeticsForUsers(userIds: number[]) {
  const userCosmetics = await cachedObject<UserCosmeticLookup>({
    key: 'cosmetics',
    idKey: 'userId',
    ids: userIds,
    lookupFn: async (ids) => {
      const userCosmeticsRaw = await dbRead.userCosmetic.findMany({
        where: { userId: { in: ids }, equippedAt: { not: null } },
        select: {
          userId: true,
          data: true,
          cosmetic: { select: { id: true, data: true, type: true, source: true, name: true } },
        },
      });
      const results = userCosmeticsRaw.reduce((acc, { userId, ...cosmetic }) => {
        acc[userId] ??= { userId, cosmetics: [] };
        acc[userId].cosmetics.push(cosmetic);
        return acc;
      }, {} as Record<number, UserCosmeticLookup>);
      return results;
    },
    ttl: 60 * 60 * 24, // 24 hours
  });

  return Object.fromEntries(Object.values(userCosmetics).map((x) => [x.userId, x.cosmetics]));
}
export async function deleteUserCosmeticCache(userId: number) {
  await bustCachedArray('cosmetics', 'userId', userId);
}

export async function getProfilePicturesForUsers(userIds: number[]) {
  return await cachedObject<ProfileImage>({
    key: 'profile-pictures',
    idKey: 'userId',
    ids: userIds,
    lookupFn: async (ids) => {
      const profilePictures = await dbRead.$queryRaw<ProfileImage[]>`
        SELECT
          i.id,
          i.name,
          i.url,
          i.nsfw,
          i.hash,
          i."userId",
          i.ingestion,
          i.type,
          i.width,
          i.height,
          i.metadata
        FROM "User" u
        JOIN "Image" i ON i.id = u."profilePictureId"
        WHERE u.id IN (${Prisma.join(ids as number[])})
      `;
      return Object.fromEntries(profilePictures.map((x) => [x.userId, x]));
    },
    ttl: 60 * 60 * 24, // 24 hours
  });
}
export async function deleteUserProfilePictureCache(userId: number) {
  await bustCachedArray('profile-pictures', 'userId', userId);
}

// #region [article engagement]
export const getUserArticleEngagements = async ({ userId }: { userId: number }) => {
  const engagements = await dbRead.articleEngagement.findMany({
    where: { userId },
    select: { articleId: true, type: true },
  });
  return engagements.reduce<Partial<Record<ArticleEngagementType, number[]>>>(
    (acc, { articleId, type }) => ({ ...acc, [type]: [...(acc[type] ?? []), articleId] }),
    {}
  );
};

export const updateLeaderboardRank = async ({
  userIds,
  leaderboardIds,
}: {
  userIds?: number | number[];
  leaderboardIds?: string | string[];
} = {}) => {
  if (userIds && !Array.isArray(userIds)) userIds = [userIds];
  if (leaderboardIds && !Array.isArray(leaderboardIds)) leaderboardIds = [leaderboardIds];

  const WHERE = [Prisma.sql`1=1`];
  if (userIds) WHERE.push(Prisma.sql`"userId" IN (${Prisma.join(userIds as number[])})`);
  if (leaderboardIds)
    WHERE.push(Prisma.sql`"leaderboardId" IN (${Prisma.join(leaderboardIds as string[])})`);

  await dbWrite.$transaction([
    dbWrite.$executeRaw`
      UPDATE "UserRank" SET "leaderboardRank" = null, "leaderboardId" = null, "leaderboardTitle" = null, "leaderboardCosmetic" = null
      WHERE ${Prisma.join(WHERE, ' AND ')};
    `,
    dbWrite.$executeRaw`
      WITH user_positions AS (
        SELECT
          lr."userId",
          lr."leaderboardId",
          l."title",
          lr.position,
          row_number() OVER (PARTITION BY "userId" ORDER BY "position") row_num
        FROM "User" u
        JOIN "LeaderboardResult" lr ON lr."userId" = u.id
        JOIN "Leaderboard" l ON l.id = lr."leaderboardId" AND l.public
        WHERE lr.date = current_date
          AND (
            u."leaderboardShowcase" IS NULL
            OR lr."leaderboardId" = u."leaderboardShowcase"
          )
      ), lowest_position AS (
        SELECT
          up."userId",
          up.position,
          up."leaderboardId",
          up."title" "leaderboardTitle",
          (
            SELECT data->>'url'
            FROM "Cosmetic" c
            WHERE c."leaderboardId" = up."leaderboardId"
              AND up.position <= c."leaderboardPosition"
            ORDER BY c."leaderboardPosition"
            LIMIT 1
          ) as "leaderboardCosmetic"
        FROM user_positions up
        WHERE row_num = 1
      )
      INSERT INTO "UserRank" ("userId", "leaderboardRank", "leaderboardId", "leaderboardTitle", "leaderboardCosmetic")
      SELECT
      "userId",
      position,
      "leaderboardId",
      "leaderboardTitle",
      "leaderboardCosmetic"
      FROM lowest_position
      WHERE ${Prisma.join(WHERE, ' AND ')}
      ON CONFLICT ("userId") DO UPDATE SET
        "leaderboardId" = excluded."leaderboardId",
        "leaderboardRank" = excluded."leaderboardRank",
        "leaderboardTitle" = excluded."leaderboardTitle",
        "leaderboardCosmetic" = excluded."leaderboardCosmetic";
    `,
  ]);
};

export const toggleBan = async ({ id }: { id: number }) => {
  const user = await getUserById({ id, select: { bannedAt: true } });
  if (!user) throw throwNotFoundError(`No user with id ${id}`);

  const updatedUser = await updateUserById({
    id,
    data: { bannedAt: user.bannedAt ? null : new Date() },
  });
  await invalidateSession(id);

  // Unpublish their models
  await dbWrite.model.updateMany({
    where: { userId: id },
    data: { publishedAt: null, status: 'Unpublished' },
  });

  // Cancel their subscription
  await cancelSubscription({ userId: id });

  return updatedUser;
};

export const toggleUserArticleEngagement = async ({
  type,
  articleId,
  userId,
}: ToggleUserArticleEngagementsInput & { userId: number }) => {
  const articleEngagements = await dbRead.articleEngagement.findMany({
    where: { userId, articleId },
    select: { type: true },
  });

  const exists = !!articleEngagements.find((x) => x.type === type);
  const toDelete: ArticleEngagementType[] = [];

  // if the engagement exists, we only need to remove the existing engagmement
  if (exists) toDelete.push(type);
  // if the engagement doesn't exist, we need to remove mutually exclusive items
  else if (articleEngagements.length) {
    if (
      type === ArticleEngagementType.Favorite &&
      !!articleEngagements.find((x) => x.type === ArticleEngagementType.Hide)
    )
      toDelete.push(ArticleEngagementType.Hide);
    else if (
      type === ArticleEngagementType.Hide &&
      !!articleEngagements.find((x) => x.type === ArticleEngagementType.Favorite)
    )
      toDelete.push(ArticleEngagementType.Favorite);
  }

  // we may need to delete items regardless of whether the current engagement exists
  if (toDelete.length) {
    await dbWrite.articleEngagement.deleteMany({
      where: { userId, articleId, type: { in: toDelete } },
    });
  }

  if (!exists) {
    await dbWrite.articleEngagement.create({ data: { userId, articleId, type } });
  }

  return !exists;
};
// #endregion

//#region [bounty engagement]
export const getUserBountyEngagements = async ({ userId }: { userId: number }) => {
  const engagements = await dbRead.bountyEngagement.findMany({
    where: { userId },
    select: { bountyId: true, type: true },
  });

  return engagements.reduce<Partial<Record<BountyEngagementType, number[]>>>(
    (acc, { bountyId, type }) => ({ ...acc, [type]: [...(acc[type] ?? []), bountyId] }),
    {}
  );
};

export const toggleUserBountyEngagement = async ({
  type,
  bountyId,
  userId,
}: ToggleUserBountyEngagementsInput & { userId: number }) => {
  const engagement = await dbRead.bountyEngagement.findUnique({
    where: { type_bountyId_userId: { userId, bountyId, type } },
    select: { type: true },
  });

  if (!engagement) {
    await dbWrite.bountyEngagement.create({ data: { userId, bountyId, type } });
    return true;
  } else {
    await dbWrite.bountyEngagement.delete({
      where: { type_bountyId_userId: { userId, bountyId, type } },
    });
    return false;
  }
};
//#endregion

// #region [user referrals]
export const userByReferralCode = async ({ userReferralCode }: UserByReferralCodeSchema) => {
  const referralCode = await dbRead.userReferralCode.findFirst({
    where: { code: userReferralCode, deletedAt: null },
    select: {
      userId: true,
      user: {
        select: userWithCosmeticsSelect,
      },
    },
  });

  if (!referralCode) {
    throw throwBadRequestError('Referral code is not valid');
  }

  return referralCode.user;
};
// #endregion

export const createUserReferral = async ({
  id,
  userReferralCode,
  source,
  landingPage,
  loginRedirectReason,
  ip,
}: {
  id: number;
  userReferralCode?: string;
  source?: string;
  landingPage?: string;
  loginRedirectReason?: string;
  ip?: string;
}) => {
  const user = await dbRead.user.findUniqueOrThrow({
    where: { id },
    select: { id: true, referral: { select: { id: true, userReferralCodeId: true } } },
  });

  if (!!user.referral?.userReferralCodeId || (!!user.referral && !userReferralCode)) {
    return;
  }

  const applyRewards = async ({
    refereeId,
    referrerId,
  }: {
    refereeId: number;
    referrerId: number;
  }) => {
    await refereeCreatedReward.apply({ refereeId, referrerId }, ip);
    await userReferredReward.apply({ refereeId, referrerId }, ip);
  };

  if (userReferralCode || source || landingPage || loginRedirectReason) {
    // Confirm userReferralCode is valid:
    const referralCode = !!userReferralCode
      ? await dbRead.userReferralCode.findFirst({
          where: { code: userReferralCode, deletedAt: null },
        })
      : null;

    if (!referralCode && !source && !landingPage && !loginRedirectReason) {
      return;
    }

    if (user.referral && referralCode && !user.referral.userReferralCodeId) {
      // Allow to update a referral with a user-referral-code:
      await dbWrite.userReferral.update({
        where: { id: user.referral.id },
        data: { userReferralCodeId: referralCode.id },
      });

      await applyRewards({
        refereeId: id,
        referrerId: referralCode.userId,
      }).catch(handleLogError);
    } else if (!user.referral) {
      // Create new referral:
      await dbWrite.userReferral.create({
        data: {
          userId: id,
          source,
          landingPage,
          loginRedirectReason,
          userReferralCodeId: referralCode?.id ?? undefined,
        },
      });

      if (referralCode?.id) {
        await applyRewards({
          refereeId: id,
          referrerId: referralCode.userId,
        }).catch(handleLogError);
      }
    }
  }
};

export const claimCosmetic = async ({ id, userId }: { id: number; userId: number }) => {
  const cosmetic = await dbRead.cosmetic.findUnique({
    where: { id, source: CosmeticSource.Claim },
    select: { id: true, availableStart: true, availableEnd: true },
  });
  if (!cosmetic) return null;
  if (!(await isCosmeticAvailable(cosmetic.id, userId))) return null;

  const userCosmetic = await dbRead.userCosmetic.findFirst({
    where: { userId, cosmeticId: cosmetic.id },
  });
  if (userCosmetic) throw throwConflictError('You already have this cosmetic');

  await dbWrite.userCosmetic.create({
    data: { userId, cosmeticId: cosmetic.id },
  });

  await usersSearchIndex.queueUpdate([{ id: userId, action: SearchIndexUpdateQueueAction.Update }]);

  return cosmetic;
};

export async function cosmeticStatus({ id, userId }: { id: number; userId: number }) {
  let available = true;
  const userCosmetic = await dbWrite.userCosmetic.findFirst({
    where: { userId, cosmeticId: id },
    select: { obtainedAt: true, equippedAt: true, data: true },
  });

  // If the user doesn't have the cosmetic, check if it's available
  if (!userCosmetic) available = await isCosmeticAvailable(id, userId);

  return {
    available,
    obtained: !!userCosmetic,
    equipped: !!userCosmetic?.equippedAt,
    data: (userCosmetic?.data ?? {}) as Record<string, unknown>,
  };
}

export async function equipCosmetic({
  cosmeticId,
  userId,
}: {
  cosmeticId: number | number[];
  userId: number;
}) {
  if (!Array.isArray(cosmeticId)) cosmeticId = [cosmeticId];
  const userCosmetics = await dbRead.userCosmetic.findMany({
    where: { userId, cosmeticId: { in: cosmeticId } },
    select: { obtainedAt: true, cosmetic: { select: { type: true } } },
  });
  if (!userCosmetics) throw new Error("You don't have that cosmetic");

  const types = [...new Set(userCosmetics.map((x) => x.cosmetic.type))];

  await dbWrite.$transaction([
    dbWrite.userCosmetic.updateMany({
      where: { userId, equippedAt: { not: null }, cosmetic: { type: { in: types } } },
      data: { equippedAt: null },
    }),
    dbWrite.userCosmetic.updateMany({
      where: { userId, cosmeticId: { in: cosmeticId } },
      data: { equippedAt: new Date() },
    }),
  ]);

  // Clear cache
  await deleteUserCosmeticCache(userId);
}
