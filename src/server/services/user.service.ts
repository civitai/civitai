import { Prisma } from '@prisma/client';
import { uniq } from 'lodash-es';
import dayjs from '~/shared/utils/dayjs';
import { env } from '~/env/server';
import { CacheTTL, constants, USERS_SEARCH_INDEX } from '~/server/common/constants';
import {
  BanReasonCode,
  BlockedReason,
  NotificationCategory,
  NsfwLevel,
  SearchIndexUpdateQueueAction,
} from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';

import { preventReplicationLag } from '~/server/db/db-lag-helpers';
import { logToAxiom } from '~/server/logging/client';
import { searchClient } from '~/server/meilisearch/client';
import { userUpdateCounter } from '~/server/prom/client';
import {
  articleMetrics,
  imageMetrics,
  modelMetrics,
  postMetrics,
  userMetrics,
} from '~/server/metrics';
import type { NotifDetailsFollowedBy } from '~/server/notifications/follow.notifications';
import type { DetailsCanceledBid } from '~/server/notifications/auction.notifications';
import { updatePaddleCustomerEmail } from '~/server/paddle/client';
import {
  cosmeticCache,
  profilePictureCache,
  userBasicCache,
  userCosmeticCache,
  userDownloadsCache,
  userFollowsCache,
} from '~/server/redis/caches';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type {
  ComputeDeviceFingerprintInput,
  DeleteUserInput,
  GetAllUsersInput,
  GetByUsernameSchema,
  GetUserCosmeticsSchema,
  GetUserListSchema,
  ToggleBanUser,
  ToggleUserBountyEngagementsInput,
  UpdateContentSettingsInput,
  UserMeta,
  UserSettingsInput,
} from '~/server/schema/user.schema';
import {
  articlesSearchIndex,
  bountiesSearchIndex,
  collectionsSearchIndex,
  imagesMetricsSearchIndex,
  imagesSearchIndex,
  modelsSearchIndex,
  usersSearchIndex,
} from '~/server/search-index';
import { purchasableRewardDetails } from '~/server/selectors/purchasableReward.selector';
import { simpleUserSelect, userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { deleteBidsForModel } from '~/server/services/auction.service';
import { isCosmeticAvailable } from '~/server/services/cosmetic.service';
import { deleteImageById } from '~/server/services/image.service';
import { userModelCountCache } from '~/server/redis/caches';
import { createNotification } from '~/server/services/notification.service';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { formatDate } from '~/utils/date-helpers';
import {
  cancelAllPaddleSubscriptions,
  cancelSubscriptionPlan,
} from '~/server/services/paddle.service';
import {
  BlockedByUsers,
  BlockedUsers,
  HiddenModels,
} from '~/server/services/user-preferences.service';
import { createCachedObject } from '~/server/utils/cache-helpers';
import {
  handleLogError,
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { encryptText, generateKey, generateSecretHash } from '~/server/utils/key-generator';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { invalidateSession, refreshSession } from '~/server/auth/session-invalidation';
import { getNsfwLevelDeprecatedReverseMapping } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import type {
  BountyEngagementType,
  CosmeticType,
  ModelEngagementType,
} from '~/shared/utils/prisma/enums';
import {
  ArticleEngagementType,
  CollectionMode,
  CollectionType,
  CosmeticSource,
  ModelStatus,
  UserEngagementType,
} from '~/shared/utils/prisma/enums';
import blockedUsernames from '~/utils/blocklist-username.json';
import { removeEmpty } from '~/utils/object-helpers';
import { isDefined } from '~/utils/type-guards';
import { simpleCosmeticSelect } from '../selectors/cosmetic.selector';
import { profileImageSelect } from '../selectors/image.selector';
import type {
  ToggleUserArticleEngagementsInput,
  UserByReferralCodeSchema,
  UserSettingsSchema,
} from './../schema/user.schema';
import { removeUserContentFromSearchIndex } from '~/server/meilisearch/util';
import { cancelSubscription } from '~/server/services/stripe.service';
// import { createFeaturebaseToken } from '~/server/featurebase/featurebase';

export const getUsersByIds = async (userIds: number[]) => {
  const users = await dbRead.user.findMany({
    where: { id: { in: userIds } },
    select: {
      id: true,
      username: true,
      email: true,
      isModerator: true,
      image: true,
      profilePicture: {
        select: profileImageSelect,
      },
    },
  });
  return users.map(({ id, username, email, isModerator, image, profilePicture }) => ({
    id,
    username,
    email,
    avatarUrl: profilePicture?.url ?? image,
    isModerator,
  }));
};

export type UserCreator = NonNullable<AsyncReturnType<typeof getUserCreator>>;
export const getUserCreator = async ({
  leaderboardId,
  isModerator,
  ...where
}: {
  username?: string;
  id?: number;
  leaderboardId?: string;
  isModerator?: boolean;
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
      excludeFromLeaderboards: true,
      links: {
        select: {
          url: true,
          type: true,
        },
      },
      stats: {
        select: {
          downloadCountAllTime: true,
          thumbsUpCountAllTime: true,
          followerCountAllTime: true,
          reactionCountAllTime: true,
          uploadCountAllTime: true,
          generationCountAllTime: true,
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

  /**
   * TODO: seems to be deprecated, we are getting model count from the stats
   * though it might be bugged since we are not updating stats if user deletes/unpublishes models
   */
  const modelCount = await dbRead.model.count({
    where: {
      userId: user?.id,
      status: 'Published',
    },
  });

  return {
    ...user,
    _count: { models: modelCount },
  };
};

type UserSearchResult = {
  id: number;
  username: string;
  deletedAt?: Date;
  profilePicture?: { url: string; nsfwLevel: NsfwLevel };
  image?: string;
};

export async function getUsersWithSearch({
  limit = 10,
  query,
  ids,
  excludedUserIds,
}: GetAllUsersInput) {
  if (!searchClient) throw new Error('Search client not available');

  const filters: string[] = [];
  if (ids?.length) filters.push(`id IN [${ids.join(',')}]`);
  if (!!excludedUserIds?.length) filters.push(`id NOT IN [${excludedUserIds.join(',')}]`);

  const results = await searchClient.index(USERS_SEARCH_INDEX).search<UserSearchResult>(query, {
    limit: Math.round(limit * 1.5),
    filter: filters.join(' AND '),
    attributesToRetrieve: ['id', 'username', 'deletedAt', 'profilePicture', 'image'],
  });
  return results.hits
    .filter((x) => !x.deletedAt)
    .map(({ deletedAt, profilePicture, image, ...user }) => ({
      ...user,
      avatarUrl: profilePicture?.url ?? image,
      avatarNsfw: profilePicture?.nsfwLevel ?? NsfwLevel.PG,
      meta: null,
    }))
    .slice(0, limit);
}

type GetUsersRow = {
  id: number;
  username: string;
  status: 'active' | 'banned' | 'muted' | 'deleted' | undefined;
  avatarUrl: string | undefined;
  avatarNsfwLevel: number;
  meta: UserMeta | undefined;
};

// Caution! this query is exposed to the public API, only non-sensitive data should be returned
export const getUsers = async ({
  limit,
  query,
  email,
  ids,
  include,
  excludedUserIds,
  contestBanned,
}: GetAllUsersInput) => {
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

  if (contestBanned) {
    select.push(`u."meta"`);
  }

  const result = await dbRead.$queryRaw<GetUsersRow[]>`
    SELECT ${Prisma.raw(select.join(','))}
    FROM "User" u
      ${Prisma.raw(
        include?.includes('avatar') ? 'LEFT JOIN "Image" i ON i.id = u."profilePictureId"' : ''
      )}
    WHERE ${ids && ids.length > 0 ? Prisma.sql`u.id IN (${Prisma.join(ids)})` : Prisma.sql`TRUE`}
      AND ${query ? Prisma.sql`u.username LIKE ${query + '%'}` : Prisma.sql`TRUE`}
      AND ${email ? Prisma.sql`u.email ILIKE ${email + '%'}` : Prisma.sql`TRUE`}
      AND ${
        excludedUserIds && excludedUserIds.length > 0
          ? Prisma.sql`u.id NOT IN (${Prisma.join(excludedUserIds)})`
          : Prisma.sql`TRUE`
      }
      AND u."deletedAt" IS NULL
      AND u."id" != -1 ${Prisma.raw(query ? 'ORDER BY LENGTH(username) ASC' : '')}
      AND ${
        contestBanned ? Prisma.sql`u."meta"->>'contestBanDetails' IS NOT NULL` : Prisma.sql`TRUE`
      }
      ${Prisma.raw(limit ? 'LIMIT ' + limit : '')}
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
  updateSource,
}: {
  id: number;
  data: Prisma.UserUpdateInput;
  updateSource?: string;
}) => {
  if (data.email) {
    const existingData = await dbWrite.user.findFirst({ where: { id }, select: { email: true } });
    if (existingData?.email) delete data.email;
  }

  if (
    typeof data.browsingLevel === 'number' &&
    Flags.hasFlag(data.browsingLevel, NsfwLevel.Blocked)
  ) {
    data.browsingLevel = Flags.removeFlag(data.browsingLevel, NsfwLevel.Blocked);
  }

  const user = await dbWrite.user.update({ where: { id }, data });

  // Track user update with optional source context
  let location = 'user.service:updateUserById';
  if (updateSource) location += `:${updateSource}`;
  userUpdateCounter?.inc({ location });

  if (data.username !== undefined || data.deletedAt !== undefined || data.image !== undefined) {
    await deleteBasicDataForUser(id);
  }

  if (data.email && user.paddleCustomerId) {
    // Update the email in Paddle
    await updatePaddleCustomerEmail({
      customerId: user.paddleCustomerId,
      email: data.email as string,
    });
  }

  return user;
};

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

export async function getUserDownloadedModelVersions({
  userId,
  modelVersionIds,
}: {
  userId: number;
  modelVersionIds?: number | number[];
}) {
  const versionIds = modelVersionIds
    ? Array.isArray(modelVersionIds)
      ? modelVersionIds
      : [modelVersionIds]
    : null;

  // Fetch cached downloads and user settings in parallel
  const [cached, { hideDownloadsSince }] = await Promise.all([
    userDownloadsCache.fetch([userId]),
    getUserSettings(userId),
  ]);

  let downloads = cached[userId]?.downloads ?? [];

  // Filter by hideDownloadsSince if set
  if (hideDownloadsSince) {
    downloads = downloads.filter((d) => d.lastDownloaded > hideDownloadsSince);
  }

  // Filter by requested modelVersionIds if provided
  if (versionIds && versionIds.length > 0) {
    const versionIdSet = new Set(versionIds);
    downloads = downloads.filter((d) => versionIdSet.has(d.modelVersionId));
  }

  return downloads.map((d) => ({ modelVersionId: d.modelVersionId }));
}

export async function bustUserDownloadsCache(userId: number) {
  await userDownloadsCache.bust([userId]);
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

  const ret = await dbWrite.userEngagement.create({
    data: { type: 'Follow', targetUserId, userId },
    select: { user: { select: { username: true } } },
  });
  await userFollowsCache.bust(userId);

  const details: NotifDetailsFollowedBy = {
    username: ret.user.username,
    userId,
  };
  await createNotification({
    category: NotificationCategory.Update,
    type: 'followed-by',
    userId: targetUserId,
    key: `followed-by:${userId}:${targetUserId}`,
    details,
  });

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
  await userFollowsCache.bust(userId);
  return true;
};

export const getUserList = async ({ username, type, limit, page }: GetUserListSchema) => {
  const user = await getUserByUsername({ username, select: { id: true } });
  if (!user) throw throwNotFoundError(`No user with username ${username}`);

  const { take = DEFAULT_PAGE_SIZE, skip = 0 } = getPagination(limit, page);
  const filteredUsers = [-1, user.id]; // Exclude civitai user and the user themselves

  if (type === 'blocked') {
    // For blocked users, we need to use the cache since it's stored differently
    const allBlocked = await BlockedUsers.getCached({ userId: user.id });
    const paginatedIds = allBlocked.slice(skip, skip + take);

    // Fetch user details for the paginated blocked users
    const items =
      paginatedIds.length > 0
        ? await dbRead.user.findMany({
            where: { id: { in: paginatedIds.map((u) => u.id) } },
            select: simpleUserSelect,
          })
        : [];

    return getPagingData({ items, count: allBlocked.length }, limit, page);
  }

  // For all other types, use userEngagement table with transaction
  const isFollowing = type === 'following';
  const isHidden = type === 'hidden';

  if (isFollowing || isHidden) {
    const whereClause = {
      userId: user.id,
      type: isHidden ? UserEngagementType.Hide : UserEngagementType.Follow,
      targetUserId: { notIn: filteredUsers },
    };

    const [items, count] = await dbRead.$transaction([
      dbRead.userEngagement.findMany({
        where: whereClause,
        select: { targetUser: { select: simpleUserSelect } },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      dbRead.userEngagement.count({ where: whereClause }),
    ]);

    const users = items.map((item) => item.targetUser);
    return getPagingData({ items: users, count }, limit, page);
  } else {
    // For followers
    const whereClause = {
      targetUserId: user.id,
      type: UserEngagementType.Follow,
      userId: { notIn: filteredUsers },
    };

    const [items, count] = await dbRead.$transaction([
      dbRead.userEngagement.findMany({
        where: whereClause,
        select: { user: { select: simpleUserSelect } },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      dbRead.userEngagement.count({ where: whereClause }),
    ]);

    const users = items.map((item) => item.user);
    return getPagingData({ items: users, count }, limit, page);
  }
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
    dbWrite.userEngagement.deleteMany({
      where: { OR: [{ userId: user.id, targetUserId: user.id }] },
    }),
    dbWrite.user.update({
      where: { id: user.id },
      data: { deletedAt: new Date(), email: null, username: null, paddleCustomerId: null },
    }),
  ]);

  userUpdateCounter?.inc({ location: 'user.service:deleteUser' });

  await usersSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
  await deleteBasicDataForUser(id);

  // Cancel their subscription
  await cancelSubscription({ userId: user.id }).catch((error) =>
    logToAxiom({ name: 'cancel-stripe-subscription', type: 'error', message: error.message })
  );
  await cancelSubscriptionPlan({ userId: user.id }).catch((error) =>
    logToAxiom({ name: 'cancel-paddle-subscription', type: 'error', message: error.message })
  );
  await invalidateSession(id);

  return result;
};

export async function setLeaderboardEligibility({ id, setTo }: { id: number; setTo: boolean }) {
  await dbWrite.$executeRawUnsafe(`
    UPDATE "User"
    SET "excludeFromLeaderboards" = ${setTo}
    WHERE id = ${id}
  `);
  userUpdateCounter?.inc({ location: 'user.service:setLeaderboardEligibility' });
}

/** Soft delete will ban the user, unsubscribe the user, and restrict access to the user's models/images  */
export async function softDeleteUser({ id, userId }: { id: number; userId: number }) {
  const user = await dbWrite.user.findFirst({
    where: { id },
    select: { isModerator: true, paddleCustomerId: true },
  });
  if (user?.isModerator) return;

  await toggleBan({
    id,
    reasonCode: BanReasonCode.SexualMinor,
    detailsInternal: 'Banned for CSAM content.',
    isModerator: false,
    userId,
    force: true,
  });

  await dbWrite.image.updateMany({
    where: { userId: id },
    data: {
      ingestion: 'Blocked',
      nsfwLevel: NsfwLevel.Blocked,
      blockedFor: BlockedReason.CSAM,
    },
  });

  await usersSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);

  // this is slightly duplicated in toggleBan
  if (user?.paddleCustomerId) {
    await cancelAllPaddleSubscriptions({ customerId: user.paddleCustomerId }).catch((error) =>
      logToAxiom({ name: 'cancel-paddle-subscription', type: 'error', message: error.message })
    );
  }
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
  await imagesMetricsSearchIndex.queueUpdate(
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

  for (const m of models) {
    await deleteBidsForModel({ modelId: m.id });
  }
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
          data: true,
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

export async function getBasicDataForUsers(userIds: number[]) {
  return await userBasicCache.fetch(userIds);
}

export async function deleteBasicDataForUser(userId: number) {
  await userBasicCache.bust(userId);
}

export async function getCosmeticsForUsers(userIds: number[]) {
  const userCosmetics = await userCosmeticCache.fetch(userIds);
  const cosmeticIds = [
    ...new Set(Object.values(userCosmetics).flatMap((x) => x.cosmetics.map((y) => y.cosmeticId))),
  ];
  const cosmetics = await cosmeticCache.fetch(cosmeticIds);
  return Object.fromEntries(
    Object.values(userCosmetics).map((x) => [
      x.userId,
      x.cosmetics.map((y) => ({
        ...y,
        cosmetic: cosmetics[y.cosmeticId],
      })),
    ])
  );
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

export const getUserBookmarkedModels = async ({ userId }: { userId: number }) => {
  // TODO should we be using resourceReview instead to get versions?

  const collections = await getUserBookmarkCollections({ userId });
  const collection = collections.find((c) => c.type === CollectionType.Model);
  if (!collection) {
    // this should be impossible, but now that I've said that, it'll happen
    throw throwNotFoundError('Could not find a matching collection.');
  }

  const bookmarked = await dbRead.collectionItem.findMany({
    where: { collectionId: collection.id },
    select: { modelId: true },
  });

  return bookmarked.map(({ modelId }) => modelId).filter(isDefined);
};

export const updateLeaderboardRank = async ({
  leaderboardIds,
}: {
  leaderboardIds?: string | string[];
} = {}) => {
  if (leaderboardIds && !Array.isArray(leaderboardIds)) leaderboardIds = [leaderboardIds];

  const leaderboardFilter = leaderboardIds
    ? Prisma.sql`AND lr."leaderboardId" IN (${Prisma.join(leaderboardIds as string[])})`
    : Prisma.empty;

  await dbWrite.$transaction([
    // Truncate the table - much faster than DELETE and we're rebuilding anyway
    dbWrite.$executeRaw`TRUNCATE TABLE "UserRank";`,
    // Only insert users with top 100 ranks (position <= 100)
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
          AND lr.position <= 100
          ${leaderboardFilter}
          AND (
            u."leaderboardShowcase" IS NULL
            OR lr."leaderboardId" = u."leaderboardShowcase"
          )
      ),
      lowest_position AS (
        SELECT
          up."userId",
          up.position,
          up."leaderboardId",
          up."title" "leaderboardTitle",
          (SELECT data ->> 'url'
           FROM "Cosmetic" c
           WHERE c."leaderboardId" = up."leaderboardId"
             AND up.position <= c."leaderboardPosition"
           ORDER BY c."leaderboardPosition"
           LIMIT 1) as "leaderboardCosmetic"
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
      FROM lowest_position;
    `,
  ]);
};

/**
 * Bulk unpublish all models for a banned user using efficient SQL operations.
 * This replaces individual unpublishModelById calls with bulk operations.
 * Also handles bulk bid deletion and refunds in minimal queries.
 */
async function bulkUnpublishModelsForBannedUser({
  odRef,
  odRefuserId,
}: {
  odRef: number;
  odRefuserId: number;
}) {
  const now = new Date();
  const unpublishedAt = now.toISOString();
  const unpublishedMeta = JSON.stringify({
    unpublishedReason: 'other',
    customMessage: 'User banned',
    unpublishedAt,
    unpublishedBy: odRefuserId,
  });

  // Get all models and their versions that need to be unpublished
  const modelsToUnpublish = await dbRead.model.findMany({
    where: {
      userId: odRef,
      status: { in: [ModelStatus.Published, ModelStatus.Scheduled] },
    },
    select: {
      id: true,
      modelVersions: {
        where: { status: { in: [ModelStatus.Published, ModelStatus.Scheduled] } },
        select: { id: true },
      },
    },
  });

  if (modelsToUnpublish.length === 0) {
    return { modelsUnpublished: 0, versionsUnpublished: 0, bidsRefunded: 0 };
  }

  const modelIds = modelsToUnpublish.map((m) => m.id);
  const versionIds = modelsToUnpublish.flatMap((m) => m.modelVersions.map((v) => v.id));

  // Bulk update models and versions in a transaction
  await dbWrite.$transaction(
    async (tx) => {
      // Update all models to Unpublished status
      await tx.$executeRaw`
        UPDATE "Model"
        SET
          status = ${ModelStatus.UnpublishedViolation}::"ModelStatus",
          meta = COALESCE(meta, '{}'::jsonb) || ${unpublishedMeta}::jsonb
        WHERE id IN (${Prisma.join(modelIds)})
      `;

      // Update all model versions to Unpublished status
      if (versionIds.length > 0) {
        await tx.$executeRaw`
          UPDATE "ModelVersion"
          SET
            status = ${ModelStatus.Unpublished}::"ModelStatus",
            meta = COALESCE(meta, '{}'::jsonb) || ${unpublishedMeta}::jsonb
          WHERE id IN (${Prisma.join(versionIds)})
        `;

        // Update posts to unpublish them
        await tx.$executeRaw`
          UPDATE "Post"
          SET
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'unpublishedAt', ${unpublishedAt},
              'unpublishedBy', ${odRefuserId},
              'prevPublishedAt', "publishedAt"
            ),
            "publishedAt" = NULL
          WHERE
            "publishedAt" IS NOT NULL
            AND "userId" = ${odRef}
            AND "modelVersionId" IN (${Prisma.join(versionIds)})
        `;
      }
    },
    { timeout: 60000 }
  );

  // Bust user model count cache
  await userModelCountCache.bust(odRef);

  // === Bulk bid deletion and refund ===
  let bidsRefunded = 0;

  if (versionIds.length > 0) {
    // Get active auctions
    const activeAuctions = await dbRead.auction.findMany({
      where: { startAt: { lte: now }, endAt: { gt: now } },
      select: { id: true },
    });
    const auctionIds = activeAuctions.map((a) => a.id);

    if (auctionIds.length > 0) {
      // Get all bids to refund (not already refunded)
      const bidsToRefund = await dbRead.bid.findMany({
        where: {
          auctionId: { in: auctionIds },
          entityId: { in: versionIds },
          isRefunded: false,
          deleted: false,
        },
        select: { id: true, userId: true, amount: true },
      });

      if (bidsToRefund.length > 0) {
        // Bulk refund all bids - chunk to avoid payload size limits
        const REFUND_BATCH_SIZE = 500;
        const refundTransactions = bidsToRefund.map((bid) => ({
          fromAccountId: 0, // Central bank
          toAccountId: bid.userId,
          amount: bid.amount,
          type: TransactionType.Refund,
          description: 'Bid refund - user banned',
          externalTransactionId: `bid-refund-ban-${odRef}-${bid.id}`,
        }));

        // Process refunds in batches
        for (let i = 0; i < refundTransactions.length; i += REFUND_BATCH_SIZE) {
          const batch = refundTransactions.slice(i, i + REFUND_BATCH_SIZE);
          try {
            await createBuzzTransactionMany(batch);
          } catch (error) {
            logToAxiom({
              type: 'error',
              name: 'ban-user-bulk-refund',
              message: error instanceof Error ? error.message : String(error),
              userId: odRef,
              bidCount: batch.length,
              batchIndex: i / REFUND_BATCH_SIZE,
            });
          }
        }

        // Mark all bids as deleted and refunded
        await dbWrite.bid.updateMany({
          where: { id: { in: bidsToRefund.map((b) => b.id) } },
          data: { deleted: true, isRefunded: true },
        });

        // Send ONE notification to all affected users
        const affectedUserIds = uniq(bidsToRefund.map((b) => b.userId));
        const bidDetails: DetailsCanceledBid = {
          name: null, // Multiple models affected
          reason: 'User banned',
          recurring: false,
        };
        await createNotification({
          userIds: affectedUserIds,
          category: NotificationCategory.System,
          type: 'canceled-bid-auction',
          key: `canceled-bid-auction:ban:${odRef}:${formatDate(now, 'YYYY-MM-DD')}`,
          details: bidDetails,
        });

        bidsRefunded = bidsToRefund.length;
      }
    }

    // Handle recurring bids - get users first for notification
    const recurringBids = await dbRead.bidRecurring.findMany({
      where: { entityId: { in: versionIds } },
      select: { id: true, userId: true },
    });

    if (recurringBids.length > 0) {
      // Delete all recurring bids
      await dbWrite.bidRecurring.deleteMany({
        where: { id: { in: recurringBids.map((r) => r.id) } },
      });

      // Send ONE notification for recurring bid cancellations
      const recurringUserIds = uniq(recurringBids.map((r) => r.userId));
      const recurringDetails: DetailsCanceledBid = {
        name: null,
        reason: 'User banned',
        recurring: true,
      };
      await createNotification({
        userIds: recurringUserIds,
        category: NotificationCategory.System,
        type: 'canceled-bid-auction',
        key: `canceled-bid-auction:recurring:ban:${odRef}:${formatDate(now, 'YYYY-MM-DD')}`,
        details: recurringDetails,
      });
    }
  }

  return {
    modelsUnpublished: modelIds.length,
    versionsUnpublished: versionIds.length,
    bidsRefunded,
  };
}

export const toggleBan = async ({
  id,
  reasonCode,
  detailsInternal,
  detailsExternal,
  userId,
  isModerator,
  force,
}: ToggleBanUser & { userId: number; isModerator?: boolean; force?: boolean }) => {
  // Get user with username for search index deletion
  const user = await getUserById({ id, select: { bannedAt: true, meta: true, username: true } });
  if (!user) throw throwNotFoundError(`No user with id ${id}`);

  const userMeta = (user.meta ?? {}) as UserMeta;
  const bannedAt = force ? null : user.bannedAt;

  const updatedMeta = bannedAt
    ? {
        ...(userMeta ?? {}),
        banDetails: undefined,
      }
    : {
        ...(userMeta ?? {}),
        banDetails: {
          reasonCode,
          detailsInternal,
          detailsExternal,
        },
      };

  const updatedUser = await updateUserById({
    id,
    data: { bannedAt: bannedAt ? null : new Date(), meta: updatedMeta },
    updateSource: 'toggleBan',
  });

  await invalidateSession(id);

  if (!bannedAt) {
    // Run cleanup operations in parallel groups
    // Group A: DB-heavy operations (run together)
    // Group B: External API operations (run together)
    await Promise.all([
      // Group A: Bulk unpublish models and handle bids
      bulkUnpublishModelsForBannedUser({ odRef: id, odRefuserId: userId }).catch((error) => {
        logToAxiom({
          type: 'error',
          name: 'ban-user-bulk-unpublish',
          message: error.message,
          error,
        });
      }),

      // Group B: External operations (subscription + search indexes)
      Promise.all([
        // Cancel their subscription
        cancelSubscriptionPlan({ userId: id }).catch((error) =>
          logToAxiom({ name: 'cancel-paddle-subscription', type: 'error', message: error.message })
        ),

        // Remove from search indexes (filter-based deletion, no DB queries)
        removeUserContentFromSearchIndex({ userId: id, username: user.username ?? '' }).catch(
          (error) =>
            logToAxiom({
              type: 'error',
              name: 'ban-user-remove-content-search-index',
              message: error.message,
              error,
            })
        ),
      ]),
    ]);
  }

  return updatedUser;
};

export const toggleContestBan = async ({
  id,
  detailsInternal,
}: ToggleBanUser & { userId: number; isModerator?: boolean; force?: boolean }) => {
  const user = await getUserById({ id, select: { meta: true } });
  if (!user) throw throwNotFoundError(`No user with id ${id}`);

  const userMeta = (user.meta ?? {}) as UserMeta;
  const bannedAt = userMeta.contestBanDetails?.bannedAt;

  const updatedMeta = bannedAt
    ? {
        ...(userMeta ?? {}),
        contestBanDetails: undefined,
      }
    : {
        ...(userMeta ?? {}),
        contestBanDetails: {
          bannedAt: new Date(),
          detailsInternal,
        },
      };

  const updatedUser = await updateUserById({
    id,
    data: { meta: updatedMeta },
    updateSource: 'toggleContestBan',
  });

  await refreshSession(id);

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
  let collection = await dbWrite.collection.findFirst({
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
  const collectionItem = await dbWrite.collectionItem.findFirst({
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

  await preventReplicationLag('resourceReview', userId);

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
    where: { id, source: { in: [CosmeticSource.Claim, CosmeticSource.Trophy] } },
    select: { id: true, availableStart: true, availableEnd: true, source: true },
  });
  if (!cosmetic) return null;
  if (cosmetic.source === CosmeticSource.Claim && !(await isCosmeticAvailable(cosmetic.id, userId)))
    return null;

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
  const collections = await dbRead.collection.findMany({
    where: { userId, mode: CollectionMode.Bookmark },
  });

  if (!collections.find((x) => x.type === CollectionType.Article)) {
    // Create the collection if it doesn't exist
    const articles = await dbWrite.collection.create({
      data: {
        userId,
        type: CollectionType.Article,
        mode: CollectionMode.Bookmark,
        name: 'Bookmarked Articles',
        description: 'Your bookmarked articles will appear in this collection.',
      },
    });

    collections.push(articles);
  }

  if (!collections.find((x) => x.type === CollectionType.Model)) {
    // Create the collection if it doesn't exist
    const models = await dbWrite.collection.create({
      data: {
        userId,
        type: CollectionType.Model,
        mode: CollectionMode.Bookmark,
        name: 'Liked Models',
        description: 'Your liked models will appear in this collection.',
      },
    });

    collections.push(models);
  }

  return collections;
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

export async function amIBlockedByUser({
  userId,
  targetUserId,
  targetUsername,
}: {
  userId: number;
  targetUserId?: number;
  targetUsername?: string;
}) {
  if (!(targetUserId || targetUsername)) return false;
  if (!targetUserId && targetUsername)
    targetUserId = (await dbRead.user.findFirst({ where: { username: targetUsername } }))?.id;

  const cachedBlockedBy = await BlockedByUsers.getCached({ userId });
  if (cachedBlockedBy.some((user) => user.id === targetUserId)) return true;

  if (!targetUserId) return false;
  if (targetUserId === userId) return false;

  const engagement = await dbRead.userEngagement.findFirst({
    where: {
      userId: targetUserId,
      targetUserId: userId,
      type: 'Block',
    },
  });

  return !!engagement;
}

export function computeFingerprint({
  fingerprint,
  userId,
}: ComputeDeviceFingerprintInput & { userId?: number }) {
  if (!env.FINGERPRINT_SECRET || !env.FINGERPRINT_IV) return fingerprint;
  return encryptText({
    text: `${fingerprint}:${userId ?? 0}:${Date.now()}`,
    key: env.FINGERPRINT_SECRET,
    iv: env.FINGERPRINT_IV,
  });
}

export async function requestAdToken({ userId }: { userId: number }) {
  const expiresAt = dayjs.utc().add(1, 'day').toDate();

  const key = generateKey();
  const token = generateSecretHash(key);

  await dbWrite.adToken.create({ data: { userId, expiresAt, token } });

  return key;
}

export async function updateContentSettings({
  userId,
  blurNsfw,
  showNsfw,
  browsingLevel,
  autoplayGifs,
  domain,
  ...data
}: UpdateContentSettingsInput & { userId: number }) {
  if (
    blurNsfw !== undefined ||
    showNsfw !== undefined ||
    // Red domain we'll store in the settings.
    (browsingLevel !== undefined && domain !== 'red') ||
    autoplayGifs !== undefined
  ) {
    await dbWrite.user.update({
      where: { id: userId },
      data: { blurNsfw, showNsfw, browsingLevel, autoplayGifs },
    });
    userUpdateCounter?.inc({ location: 'user.service:updateUserContentSettings' });
  }
  if (Object.keys(data).length > 0 || (domain === 'red' && browsingLevel !== undefined)) {
    const settings = await getUserSettings(userId);
    if (domain === 'red' && browsingLevel !== undefined) {
      settings.redBrowsingLevel = browsingLevel;
    }

    await setUserSetting(userId, { ...settings, ...removeEmpty(data) });
  }
  await refreshSession(userId);
}

export const getUserByPaddleCustomerId = async ({
  paddleCustomerId,
}: {
  paddleCustomerId: string;
}) => {
  const user = await dbRead.user.findFirst({
    where: { paddleCustomerId },
    select: { id: true, username: true },
  });

  return user;
};

// #region [user settings]
const userSettingsCache = createCachedObject<UserSettingsSchema & { userId: number }>({
  key: REDIS_KEYS.USER.SETTINGS,
  idKey: 'userId',
  ttl: CacheTTL.hour * 4,
  staleWhileRevalidate: false,
  lookupFn: async (ids) => {
    const settings = await dbWrite.$queryRaw<{ id: number; settings: UserSettingsSchema }[]>`
    SELECT id, settings
    FROM "User"
    WHERE id IN (${Prisma.join(ids)})
  `;
    return Object.fromEntries(settings.map((x) => [x.id, { userId: x.id, ...x.settings }]));
  },
});

export async function getUserSettings(id: number) {
  const result = await userSettingsCache.fetch([id]);
  const { userId, ...settings } = result[id] ?? {};
  return settings;
}

export async function setUserSetting(userId: number, settings: UserSettingsInput) {
  const toSet = removeEmpty(settings);
  const keys = Object.keys(toSet);
  if (!keys.length) return;

  await dbWrite.$executeRawUnsafe(`
      UPDATE "User"
      SET settings = COALESCE(settings, '{}') || '${JSON.stringify(toSet)}'::jsonb
      WHERE id = ${userId}
    `);
  userUpdateCounter?.inc({ location: 'user.service:setUserSetting:set' });

  const toRemove = Object.entries(settings)
    .filter(([, value]) => value === undefined)
    .map(([key]) => `'${key}'`);
  if (toRemove.length) {
    await dbWrite.$executeRawUnsafe(`
      UPDATE "User"
      SET settings = settings - ${toRemove.join(' - ')}}
      WHERE id = ${userId}
    `);
    userUpdateCounter?.inc({ location: 'user.service:setUserSetting:remove' });
  }

  await userSettingsCache.bust([userId]);
}
// #endregion
