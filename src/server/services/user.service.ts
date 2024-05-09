import {
  ArticleEngagementType,
  BountyEngagementType,
  CollectionMode,
  CollectionType,
  CosmeticSource,
  CosmeticType,
  ModelEngagementType,
  Prisma,
} from '@prisma/client';
import { env } from '~/env/server.mjs';
import { constants } from '~/server/common/constants';
import { NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  articleMetrics,
  imageMetrics,
  modelMetrics,
  postMetrics,
  userMetrics,
} from '~/server/metrics';
import { playfab } from '~/server/playfab/client';
import { profilePictureCache, userCosmeticCache } from '~/server/redis/caches';
import { REDIS_KEYS } from '~/server/redis/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  DeleteUserInput,
  GetAllUsersInput,
  GetByUsernameSchema,
  GetUserCosmeticsSchema,
  ToggleUserBountyEngagementsInput,
} from '~/server/schema/user.schema';
import {
  articlesSearchIndex,
  bountiesSearchIndex,
  collectionsSearchIndex,
  imagesSearchIndex,
  modelsSearchIndex,
  usersSearchIndex,
} from '~/server/search-index';
import { purchasableRewardDetails } from '~/server/selectors/purchasableReward.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { isCosmeticAvailable } from '~/server/services/cosmetic.service';
import { deleteImageById } from '~/server/services/image.service';
import { cancelSubscription } from '~/server/services/stripe.service';
import { getSystemPermissions } from '~/server/services/system-cache';
import { HiddenModels } from '~/server/services/user-preferences.service';
import {
  handleLogError,
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { invalidateSession } from '~/server/utils/session-helpers';
import { getNsfwLevelDeprecatedReverseMapping } from '~/shared/constants/browsingLevel.constants';
import blockedUsernames from '~/utils/blocklist-username.json';
import { removeEmpty } from '~/utils/object-helpers';
import { simpleCosmeticSelect } from '../selectors/cosmetic.selector';
import { ProfileImage, profileImageSelect } from '../selectors/image.selector';
import {
  ToggleUserArticleEngagementsInput,
  UserByReferralCodeSchema,
  UserSettingsSchema,
  UserTier,
} from './../schema/user.schema';
// import { createFeaturebaseToken } from '~/server/featurebase/featurebase';

export const getUserCreator = async ({
  leaderboardId,
  ...where
}: {
  username?: string;
  id?: number;
  leaderboardId?: string;
}) => {
  const user = await dbRead.user.findFirst({
    where: {
      ...where,
      deletedAt: null,
      AND: [
        { id: { not: constants.system.user.id } },
        { username: { not: constants.system.user.username } },
      ],
    },
    select: {
      id: true,
      image: true,
      username: true,
      muted: true,
      bannedAt: true,
      deletedAt: true,
      createdAt: true,
      publicSettings: true,
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
          thumbsUpCountAllTime: true,
          followerCountAllTime: true,
          reactionCountAllTime: true,
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
            select: simpleCosmeticSelect,
          },
        },
      },
      profilePicture: {
        select: profileImageSelect,
      },
    },
  });
  if (!user) return null;

  const modelCount = dbRead.model.count({
    where: {
      userId: user?.id,
      status: 'Published',
    },
  });

  return {
    ...user,
    _count: {
      models: Number(modelCount),
    },
  };
};

type GetUsersRow = {
  id: number;
  username: string;
  status: 'active' | 'banned' | 'muted' | 'deleted' | undefined;
  avatarUrl: string | undefined;
  avatarNsfwLevel: number;
};

// Caution! this query is exposed to the public API, only non-sensitive data should be returned
export const getUsers = async ({ limit, query, email, ids, include }: GetAllUsersInput) => {
  const select = ['u.id', 'u.username'];
  if (include?.includes('status'))
    select.push(`
      CASE
        WHEN u."deletedAt" IS NOT NULL THEN 'deleted'
        WHEN u."bannedAt" IS NOT NULL THEN 'banned'
        WHEN u.muted IS TRUE THEN 'muted'
        ELSE 'active'
      END AS status`);
  if (include?.includes('avatar'))
    select.push(
      'COALESCE(i.url, u.image) AS "avatarUrl"',
      `COALESCE(i.nsfwLevel, 'None') AS "avatarNsfwLevel"`
    );

  const result = await dbRead.$queryRaw<GetUsersRow[]>`
    SELECT ${Prisma.raw(select.join(','))}
    FROM "User" u
      ${Prisma.raw(
        include?.includes('avatar') ? 'LEFT JOIN "Image" i ON i.id = u."profilePictureId"' : ''
      )}
    WHERE ${ids && ids.length > 0 ? Prisma.sql`u.id IN (${Prisma.join(ids)})` : Prisma.sql`TRUE`}
      AND ${query ? Prisma.sql`u.username LIKE ${query + '%'}` : Prisma.sql`TRUE`}
      AND ${email ? Prisma.sql`u.email ILIKE ${email + '%'}` : Prisma.sql`TRUE`}
      AND u."deletedAt" IS NULL
      AND u."id" != -1 ${Prisma.raw(query ? 'ORDER BY LENGTH(username) ASC' : '')} ${Prisma.raw(
    limit ? 'LIMIT ' + limit : ''
  )}
  `;
  return result.map(({ avatarNsfwLevel, ...user }) => ({
    ...user,
    avatarNsfw: getNsfwLevelDeprecatedReverseMapping(avatarNsfwLevel),
  }));
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
  if (data.email) {
    const existingData = await dbWrite.user.findFirst({ where: { id }, select: { email: true } });
    if (existingData?.email) delete data.email;
  }

  const user = await dbWrite.user.update({ where: { id }, data });

  return user;
};

export async function setUserSetting(userId: number, settings: UserSettingsSchema) {
  const toSet = removeEmpty(settings);
  if (Object.keys(toSet).length) {
    await dbWrite.$executeRawUnsafe(`
      UPDATE "User"
      SET settings = COALESCE(settings, '{}') || '${JSON.stringify(toSet)}'::jsonb
      WHERE id = ${userId}
    `);
  }

  const toRemove = Object.entries(settings)
    .filter(([, value]) => value === undefined)
    .map(([key]) => `'${key}'`);
  if (toRemove.length) {
    await dbWrite.$executeRawUnsafe(`
      UPDATE "User"
      SET settings = settings - ${toRemove.join(' - ')}}'
      WHERE id = ${userId}
    `);
  }
}

export async function getUserSettings(userId: number) {
  const settings = await dbWrite.$queryRaw<{ settings: UserSettingsSchema }[]>`
    SELECT settings
    FROM "User"
    WHERE id = ${userId}
  `;
  return settings[0]?.settings ?? {};
}

export const getUserEngagedModels = ({ id, type }: { id: number; type?: ModelEngagementType }) => {
  return dbRead.modelEngagement.findMany({
    where: { userId: id, type },
    select: { modelId: true, type: true },
  });
};

export async function getUserEngagedModelVersions({
  userId,
  modelVersionIds,
}: {
  userId: number;
  modelVersionIds: number | number[];
}) {
  const versionIds = Array.isArray(modelVersionIds) ? modelVersionIds : [modelVersionIds];

  return dbRead.modelVersionEngagement.findMany({
    where: { userId, modelVersionId: { in: versionIds } },
    select: { modelVersionId: true, type: true },
  });
}

export async function getUserDownloads({
  userId,
  modelVersionIds,
}: {
  userId: number;
  modelVersionIds?: number | number[];
}) {
  const where: Prisma.DownloadHistoryWhereInput = {
    userId,
  };
  if (modelVersionIds) {
    const versionIds = Array.isArray(modelVersionIds) ? modelVersionIds : [modelVersionIds];
    where.modelVersionId = { in: versionIds };
  }

  return dbRead.downloadHistory.findMany({
    where,
    select: { modelVersionId: true },
    distinct: ['modelVersionId'],
  });
}

export const getUserEngagedModelByModelId = ({
  userId,
  modelId,
}: {
  userId: number;
  modelId: number;
}) => {
  return dbRead.modelEngagement.findUnique({ where: { userId_modelId: { userId, modelId } } });
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
  setTo,
}: {
  userId: number;
  modelId: number;
  type: ModelEngagementType;
  setTo?: boolean;
}) => {
  const engagement = await dbWrite.modelEngagement.findUnique({
    where: { userId_modelId: { userId, modelId } },
    select: { type: true },
  });
  setTo ??= engagement?.type === type ? false : true;

  if (engagement) {
    if (!setTo && engagement.type === type) {
      await dbWrite.modelEngagement.delete({
        where: { userId_modelId: { userId, modelId } },
      });
      if (type === 'Hide') await HiddenModels.refreshCache({ userId });
      return false;
    } else if (setTo && engagement.type !== type) {
      await dbWrite.modelEngagement.update({
        where: { userId_modelId: { userId, modelId } },
        data: { type, createdAt: new Date() },
      });
      return true;
    }
    return true; // no change
  } else if (setTo === false) return false;

  await dbWrite.modelEngagement.create({ data: { type, modelId, userId } });
  if (type === 'Hide') await HiddenModels.refreshCache({ userId });
  return true;
};

export const toggleModelNotify = async ({ userId, modelId }: { userId: number; modelId: number }) =>
  toggleModelEngagement({ userId, modelId, type: 'Notify' });

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

/** Soft delete will ban the user, unsubscribe the user, and restrict access to the user's models/images  */
export async function softDeleteUser({ id }: { id: number }) {
  await dbWrite.model.updateMany({
    where: { userId: id },
    data: { status: 'UnpublishedViolation' },
  });
  await dbWrite.image.updateMany({
    where: { userId: id },
    data: {
      ingestion: 'Blocked',
      nsfwLevel: NsfwLevel.Blocked,
      blockedFor: 'CSAM',
      needsReview: 'blocked',
    },
  });
  await cancelSubscription({ userId: id });
  await dbWrite.user.update({ where: { id }, data: { bannedAt: new Date() } });
  await invalidateSession(id);
  await usersSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
}

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

  const response = await dbWrite.user.findFirst({
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
  if (!response) return undefined;

  // nb: doing this because these fields are technically nullable, but prisma
  // likes returning them as undefined. that messes with the typing.
  const user = {
    ...response,
    image: response.image ?? undefined,
    referral: response.referral ?? undefined,
    name: response.name ?? undefined,
    username: response.username ?? undefined,
    email: response.email ?? undefined,
    emailVerified: response.emailVerified ?? undefined,
    isModerator: response.isModerator ?? undefined,
    deletedAt: response.deletedAt ?? undefined,
    customerId: response.customerId ?? undefined,
    subscriptionId: response.subscriptionId ?? undefined,
    mutedAt: response.mutedAt ?? undefined,
    bannedAt: response.bannedAt ?? undefined,
    autoplayGifs: response.autoplayGifs ?? undefined,
    leaderboardShowcase: response.leaderboardShowcase ?? undefined,
    filePreferences: (response.filePreferences ?? undefined) as UserFilePreferences | undefined,
  };

  const { subscription, profilePicture, profilePictureId, settings, ...rest } = user;
  const tier: UserTier | undefined =
    subscription && ['active', 'trialing'].includes(subscription.status)
      ? (subscription.product.metadata as any)[env.STRIPE_METADATA_KEY]
      : undefined;
  const memberInBadState =
    (subscription &&
      ['incomplete', 'incomplete_expired', 'past_due', 'unpaid'].includes(subscription.status)) ??
    undefined;

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
    memberInBadState,
    // feedbackToken,
  };
};

export const removeAllContent = async ({ id }: { id: number }) => {
  const models = await dbRead.model.findMany({ where: { userId: id }, select: { id: true } });
  const images = await dbRead.image.findMany({
    where: { userId: id },
    select: { id: true, url: true },
  });
  const articles = await dbRead.article.findMany({ where: { userId: id }, select: { id: true } });
  const collections = await dbRead.collection.findMany({
    where: { userId: id },
    select: { id: true },
  });
  const bounties = await dbRead.collection.findMany({
    where: { userId: id },
    select: { id: true },
  });

  // sort deletes by least impactful to most impactful
  await dbWrite.imageReaction.deleteMany({ where: { userId: id } });
  await dbWrite.articleReaction.deleteMany({ where: { userId: id } });
  await dbWrite.commentReaction.deleteMany({ where: { userId: id } });
  await dbWrite.commentV2Reaction.deleteMany({ where: { userId: id } });
  await dbWrite.bountyEntry.deleteMany({
    where: { userId: id, benefactors: { none: {} } },
  });
  await dbWrite.bounty.deleteMany({ where: { userId: id } });
  await dbWrite.answer.deleteMany({ where: { userId: id } });
  await dbWrite.question.deleteMany({ where: { userId: id } });
  await dbWrite.userLink.deleteMany({ where: { userId: id } });
  await dbWrite.userProfile.deleteMany({ where: { userId: id } });
  await dbWrite.resourceReview.deleteMany({ where: { userId: id } });
  await dbWrite.commentV2.deleteMany({ where: { userId: id } });
  await dbWrite.comment.deleteMany({ where: { userId: id } });
  await dbWrite.collection.deleteMany({ where: { userId: id } });
  await dbWrite.article.deleteMany({ where: { userId: id } });
  await dbWrite.post.deleteMany({ where: { userId: id } });
  await dbWrite.model.deleteMany({ where: { userId: id } });
  await dbWrite.chatMessage.deleteMany({ where: { userId: id } });
  await dbWrite.chatMember.deleteMany({ where: { userId: id } });

  // remove images from s3 buckets before deleting them
  try {
    for (const image of images) {
      await deleteImageById({ id: image.id });
    }
  } catch (e) {}
  await dbWrite.image.deleteMany({ where: { userId: id } });

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
          equippedToId: true,
          equippedToType: true,
          forId: true,
          forType: true,
          claimKey: true,
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

export async function getCosmeticsForUsers(userIds: number[]) {
  const userCosmetics = await userCosmeticCache.fetch(userIds);
  return Object.fromEntries(Object.values(userCosmetics).map((x) => [x.userId, x.cosmetics]));
}

export async function deleteUserCosmeticCache(userId: number) {
  await userCosmeticCache.bust(userId);
}

export async function getProfilePicturesForUsers(userIds: number[]) {
  return await profilePictureCache.fetch(userIds);
}
export async function deleteUserProfilePictureCache(userId: number) {
  await profilePictureCache.bust(userId);
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

export const getUserBookmarkedArticles = async ({ userId }: { userId: number }) => {
  let collection = await dbRead.collection.findFirst({
    where: { userId, type: CollectionType.Article, mode: CollectionMode.Bookmark },
  });

  if (!collection) {
    // Create the collection if it doesn't exist
    collection = await dbWrite.collection.create({
      data: {
        userId,
        type: CollectionType.Article,
        mode: CollectionMode.Bookmark,
        name: 'Bookmarked Articles',
        description: 'Your bookmarked articles will appear in this collection.',
      },
    });
  }

  const bookmarked = await dbRead.collectionItem.findMany({
    where: { collectionId: collection.id },
    select: { articleId: true },
  });

  return bookmarked.map(({ articleId }) => articleId);
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
      UPDATE "UserRank"
      SET "leaderboardRank"     = null,
          "leaderboardId"       = null,
          "leaderboardTitle"    = null,
          "leaderboardCosmetic" = null
      WHERE ${Prisma.join(WHERE, ' AND ')};
    `,
    dbWrite.$executeRaw`
      WITH user_positions AS (SELECT lr."userId",
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
                                )),
           lowest_position AS (SELECT up."userId",
                                      up.position,
                                      up."leaderboardId",
                                      up."title"   "leaderboardTitle",
                                      (SELECT data ->> 'url'
                                       FROM "Cosmetic" c
                                       WHERE c."leaderboardId" = up."leaderboardId"
                                         AND up.position <= c."leaderboardPosition"
                                       ORDER BY c."leaderboardPosition"
                                       LIMIT 1) as "leaderboardCosmetic"
                               FROM user_positions up
                               WHERE row_num = 1)
      INSERT
      INTO "UserRank" ("userId", "leaderboardRank", "leaderboardId", "leaderboardTitle", "leaderboardCosmetic")
      SELECT "userId",
             position,
             "leaderboardId",
             "leaderboardTitle",
             "leaderboardCosmetic"
      FROM lowest_position
      WHERE ${Prisma.join(WHERE, ' AND ')}
      ON CONFLICT ("userId") DO UPDATE SET "leaderboardId"       = excluded."leaderboardId",
                                           "leaderboardRank"     = excluded."leaderboardRank",
                                           "leaderboardTitle"    = excluded."leaderboardTitle",
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

export const toggleBookmarkedArticle = async ({
  articleId,
  userId,
}: {
  articleId: number;
  userId: number;
}) => toggleBookmarked({ entityId: articleId, type: CollectionType.Article, userId });

const collectionEntityProps = {
  [CollectionType.Article]: 'articleId',
  [CollectionType.Model]: 'modelId',
  [CollectionType.Image]: 'imageId',
  [CollectionType.Post]: 'postId',
};
const collectionEntityMetrics = {
  [CollectionType.Article]: articleMetrics,
  [CollectionType.Model]: modelMetrics,
  [CollectionType.Image]: imageMetrics,
  [CollectionType.Post]: postMetrics,
};
export const toggleBookmarked = async ({
  entityId,
  type,
  userId,
  setTo,
}: {
  entityId: number;
  type: CollectionType;
  userId: number;
  setTo?: boolean;
}) => {
  let collection = await dbRead.collection.findFirst({
    where: { userId, type, mode: CollectionMode.Bookmark },
  });
  if (!collection) {
    collection = await dbWrite.collection.create({
      data: {
        userId,
        type,
        mode: CollectionMode.Bookmark,
        name: `Bookmarked ${type}`,
        description: `Your bookmarked ${type.toLowerCase()} will appear in this collection.`,
      },
    });
  }

  const entityProp = collectionEntityProps[type];
  const collectionItem = await dbRead.collectionItem.findFirst({
    where: {
      [entityProp]: entityId,
      collectionId: collection.id,
    },
  });

  const exists = collectionItem;

  // if the engagement exists, we only need to remove the existing engagmement
  if (exists && setTo !== true) {
    await dbWrite.collectionItem.delete({
      where: {
        id: collectionItem.id,
      },
    });
    const metricsEngine = collectionEntityMetrics[type];
    metricsEngine.queueUpdate(entityId);
  } else if (!exists && setTo !== false) {
    await dbWrite.collectionItem.create({
      data: { collectionId: collection.id, [entityProp]: entityId },
    });
  }

  return !exists;
};
// #endregion

// #region [review]
export async function toggleReview({
  modelId,
  userId,
  modelVersionId,
  setTo,
}: {
  modelId: number;
  userId: number;
  modelVersionId?: number;
  setTo?: boolean;
}) {
  const review = await dbRead.resourceReview.findFirst({
    where: { modelId, modelVersionId, userId },
    select: { id: true, recommended: true },
  });
  setTo ??= review ? false : true;

  if (setTo === false) {
    await dbWrite.resourceReview.deleteMany({ where: { modelId, modelVersionId, userId } });
    modelMetrics.queueUpdate(modelId);
  } else {
    if (review) {
      if (setTo !== review.recommended) {
        await dbWrite.resourceReview.update({
          where: { id: review.id },
          data: { recommended: setTo },
        });
      }
    } else {
      if (!modelVersionId) {
        const latestVersion = await dbRead.modelVersion.findFirst({
          where: { modelId, status: 'Published' },
          orderBy: { index: 'asc' },
          select: { id: true },
        });
        modelVersionId = latestVersion?.id;
        if (!modelVersionId) throw throwNotFoundError('No published model versions found');
      }

      await dbWrite.resourceReview.create({
        data: {
          modelId,
          modelVersionId,
          userId,
          recommended: setTo,
          rating: setTo ? 5 : 1,
        },
      });
    }
  }

  return setTo;
}

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
    // await refereeCreatedReward.apply({ refereeId, referrerId }, ip);
    // await userReferredReward.apply({ refereeId, referrerId }, ip);
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
  if (!cosmeticId.length) return;

  const userCosmetics = await dbRead.userCosmetic.findMany({
    where: { userId, cosmeticId: { in: cosmeticId } },
    select: { obtainedAt: true, cosmetic: { select: { type: true } } },
  });
  if (!userCosmetics.length) throw new Error("You don't have that cosmetic");

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

export async function unequipCosmeticByType({
  type,
  userId,
}: {
  type: CosmeticType;
  userId: number;
}) {
  await dbWrite.userCosmetic.updateMany({
    where: { userId, cosmetic: { type }, equippedAt: { not: null } },
    data: { equippedAt: null },
  });
  await deleteUserCosmeticCache(userId);
}

export const getUserBookmarkCollections = async ({ userId }: { userId: number }) => {
  return dbRead.collection.findMany({
    where: { userId, mode: CollectionMode.Bookmark },
  });
};

export const getUserPurchasedRewards = async ({ userId }: { userId: number }) => {
  return dbRead.userPurchasedRewards.findMany({
    where: { userId },
    select: {
      code: true,
      meta: true,
      purchasableReward: {
        select: purchasableRewardDetails,
      },
    },
  });
};
