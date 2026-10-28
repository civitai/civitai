import { Prisma } from '@prisma/client';
import {
  accountHoldSql,
  assertAccountNotUnderLegalHold,
  guardedAccountScrubSql,
  isLegalHoldAbort,
  LegalHoldError,
  LegalHoldStoppedError,
  heldModelIdsSql,
  recordCurrentModelOwnersSql,
  recordModelOwnershipSql,
} from '~/server/services/legal-hold.service';
import { KEPT_MODEL_STATUS, PLACEHOLDER_OWNER_ID } from '~/server/utils/legal-hold';
import { TRPCError } from '@trpc/server';
import { uniq } from 'lodash-es';
import dayjs from '~/shared/utils/dayjs';
import {
  banReasonDetails,
  banReasonsAlwaysRemovingMedia,
  CacheTTL,
  constants,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';
import { moderationActionEmail } from '~/server/email/templates';
import {
  BanReasonCode,
  BlockedReason,
  NotificationCategory,
  NsfwLevel,
  SearchIndexUpdateQueueAction,
} from '~/server/common/enums';
import { clickhouse } from '~/server/clickhouse/client';
import { listModelEngagements } from '@civitai/db-queries/model';
import { dbRead, dbWrite } from '~/server/db/client';
import { contestBannedAtSql, contestBannedSql } from '~/server/services/contest-ban';
import { onModelReviewsChanged } from '~/server/events/points/hooks';
import { syncEventRosterMember } from '~/server/events/points/roster-sync';
import { syncOwnerEventHats } from '~/server/events/points/sync';
import { kyselyRead } from '~/server/db/kyselyDb';

import { preventReplicationLag } from '~/server/db/db-lag-helpers';
import { logToAxiom } from '~/server/logging/client';
import { isTransientMeiliError, searchClient, withMeili } from '~/server/meilisearch/client';
import { dbReadFallbackCounter, userUpdateCounter } from '~/server/prom/client';
import {
  articleMetrics,
  modelCollectionMetrics,
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
  setUserFollowCached,
  userDownloadsCache,
  userFollowsCache,
} from '~/server/redis/caches';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type {
  DeleteUserInput,
  GetAllUsersInput,
  GetByUsernameSchema,
  GetUserCosmeticsSchema,
  GetUserListSchema,
  RestoreUserInput,
  ToggleBanUser,
  ToggleUserBountyEngagementsInput,
  UpdateContentSettingsInput,
  UserContentSettings,
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
import { queueWornCosmeticsUpdate } from '~/server/search-index/users.search-index';
import { purchasableRewardDetails } from '~/server/selectors/purchasableReward.selector';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';
import { simpleUserSelect, userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { refundBidsForVersions } from '~/server/services/auction.service';
import { bustUserMetricPrivacyDefaultsCache } from '~/server/services/creator-membership.service';
import {
  isCosmeticAvailable,
  refuseIfWithheldAfterEquip,
} from '~/server/services/cosmetic.service';
import {
  WITHHELD_COSMETIC_ERROR,
  getWithheldCosmeticIds,
} from '~/server/services/creator-shop-withheld';
import { bustModelSaleCacheForModels } from '~/server/services/paid-access.service';
import {
  countPendingAccountDeletionImageRestores,
  disarmAccountDeletionImagePurge,
  recordPendingImageRestore,
} from '~/server/services/account-deletion-images';
import { clearAccountDeletionImageMarkers } from '~/server/services/account-deletion-image-markers';
import { deleteImages } from '~/server/services/image.service';
import {
  refreshOwnedStickerCache,
  userContentOverviewCache,
  userModelCountCache,
} from '~/server/redis/caches';
import { createNotification } from '~/server/services/notification.service';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { isEventDecorationData } from '~/shared/constants/event-decoration.constants';
import { chunkIds } from '~/utils/array-helpers';
import { formatDate } from '~/utils/date-helpers';
import {
  cancelAllPaddleSubscriptions,
  cancelSubscriptionPlan,
} from '~/server/services/paddle.service';
import {
  BlockedByUsers,
  BlockedUsers,
  HiddenModels,
  HiddenUsers,
} from '~/server/services/user-preferences.service';
import { clearUserEngagement } from '~/server/services/user-engagement';
import { createCachedObject, fetchThroughCache } from '~/server/utils/cache-helpers';
import { bustRatingTotalsCache } from '~/server/services/resourceReview.cache';
import {
  handleLogError,
  isPrismaUniqueViolation,
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { imageRemovalMode, PRIOR_INGESTION_KEY } from '~/server/utils/image-removal-mode';
import { generateKey, generateSecretHash } from '~/server/utils/key-generator';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { invalidateSession, refreshSession } from '~/server/auth/session-invalidation';
import { getNsfwLevelDeprecatedReverseMapping } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import type { BountyEngagementType, ModelEngagementType } from '~/shared/utils/prisma/enums';
import {
  ArticleEngagementType,
  CollectionMode,
  CollectionType,
  CosmeticSource,
  CosmeticType,
  ModelStatus,
  UserEngagementType,
} from '~/shared/utils/prisma/enums';
import { assertEmailAllowed } from '~/server/services/blocklist.service';
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
import { cancelSubscription, reinstateSubscription } from '~/server/services/stripe.service';
import {
  clearBlockInstancesForPublisher,
  revokeBlockInstancesForPublisher,
} from '~/server/services/blocks/publisher-ban-revocation.service';
import { queueScamScan } from '~/server/services/text-scan/scam-scan-queue';
import { releaseUserMute, type MuteReleaseActivity } from '~/server/services/mute-release.service';
import {
  closeGenerationRestrictionsOfDeletedAccount,
  reopenGenerationRestrictionsOfRestoredAccount,
} from '~/server/services/user-restriction.service';
import {
  bustUserCreatorCache,
  fetchUserCreator,
  getCachedUserCreator,
} from '~/server/services/user-creator.service';
import { asJsonbObject, asJsonbObjectSql } from '~/server/utils/jsonb-object';

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
  // An id on its own is the hot shape (creator card, header) and is served from a short-TTL
  // per-user cache; what invalidates it is documented on `userCreatorCache`. A username lookup
  // reads the database as before.
  if (where.id !== undefined && where.username === undefined)
    return await getCachedUserCreator(where.id);
  return await fetchUserCreator(where);
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

  let results;
  try {
    // Narrow withMeili wrap to the SDK call only — this is a user-facing tRPC
    // path (user.getAll). Under Meilisearch brownout an unwrapped .search() can
    // hang ~30s, the same failure mode that bled api-primary to kubelet SIGKILL
    // on 2026-05-29. Follow-up to PR #2351, which wrapped the image-feed call
    // sites but missed this one.
    results = await withMeili('search', () =>
      searchClient!.index(USERS_SEARCH_INDEX).search<UserSearchResult>(query, {
        limit: Math.round(limit * 1.5),
        filter: filters.join(' AND '),
        attributesToRetrieve: ['id', 'username', 'deletedAt', 'profilePicture', 'image'],
      })
    );
  } catch (err) {
    // Mirror /api/v1/images (#2759/#2765): surface a fast, retryable 503 via
    // TRPCError SERVICE_UNAVAILABLE so the client can retry instead of waiting
    // on Traefik's 30s router timeout. (Was TIMEOUT/408 under tRPC v10, which
    // lacked SERVICE_UNAVAILABLE; v11 has it.)
    //
    // Widened from `instanceof MeiliCallTimeoutError` to isTransientMeiliError:
    // the timeout-wrapper only covers civitai's own MeiliCallTimeoutError, but a
    // Meilisearch brownout also throws the SDK's OWN transient error types
    // (MeiliSearchCommunicationError with statusCode=408/503, MeiliSearchApiError
    // with a gateway httpStatus, MeiliSearchTimeOutError, network ECONNRESET, …).
    // Those fell through this branch as raw Errors → throwDbError wrapped them as
    // TRPCError INTERNAL_SERVER_ERROR → the handler emitted a raw 500 (the top
    // REST 500 source on the ?query= path). Converting them here preserves the
    // "transient" signal as SERVICE_UNAVAILABLE through throwDbError (which
    // re-throws an existing TRPCError unchanged) so the handler maps it to 503.
    // Non-transient errors (malformed filter / auth / real app bug) are NOT
    // matched and continue to surface as their real status (500).
    if (isTransientMeiliError(err)) {
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'User search is temporarily overloaded — please retry.',
        cause: err,
      });
    }
    throw err;
  }

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

  // The contest-ban list is a WINDOW over a set larger than itself, so without an order it showed an
  // arbitrary twenty of them and a ban that had just succeeded landed anywhere — which is why it read
  // as "the ban did nothing". Newest ban first is the only order that makes the write visible.
  // `bannedAt` is an ISO-8601 UTC string, so the text sort is chronological; every row carries one
  // (checked against production).
  const orderBy = contestBanned
    ? Prisma.sql`ORDER BY ${contestBannedAtSql} DESC`
    : query
    ? Prisma.sql`ORDER BY LENGTH(username) ASC`
    : Prisma.empty;

  // ORDER BY goes after every predicate. It used to share a line with `u."id" != -1`, above the
  // `contestBanned` clause, so a caller passing both emitted `... ORDER BY ... AND ...` and Postgres
  // rejected the statement with 42601. `user.getAll` routes here whenever a moderator sets
  // `contestBanned`, and `query` is on the same input schema, so that combination is reachable.
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
          ? Prisma.sql`u.id != ALL(${excludedUserIds}::int[])`
          : Prisma.sql`TRUE`
      }
      AND u."deletedAt" IS NULL
      AND u."id" != -1
      AND ${contestBanned ? contestBannedSql : Prisma.sql`TRUE`}
      ${orderBy}
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

export { isUsernamePermitted } from '~/server/services/username-permitted';

/**
 * Mod-driven: clear public profile fields (location/bio/message) on UserProfile.
 * No-op if no UserProfile row exists yet.
 *
 * Clearing bio/message also clears its SFW (civitai.com) override — otherwise the
 * copy a moderator just removed keeps rendering on the green domain.
 */
export async function clearUserProfileFields({
  userId,
  fields = ['location', 'bio', 'message'],
}: {
  userId: number;
  fields?: Array<'location' | 'bio' | 'message'>;
}) {
  if (fields.length === 0) return { updated: false };
  const data: Prisma.UserProfileUpdateInput = {};
  if (fields.includes('location')) data.location = null;
  if (fields.includes('bio')) {
    data.bio = null;
    data.sfwBio = null;
  }
  if (fields.includes('message')) {
    data.message = null;
    data.sfwMessage = null;
    data.sfwMessageAddedAt = null;
  }
  const result = await dbWrite.userProfile.updateMany({ where: { userId }, data });
  return { updated: result.count > 0 };
}

/**
 * A moderator's mute, timed or not.
 *
 * `mutedAt` is what marks it as a person's decision: every automatic path (strike escalation, prompt
 * auditing, scam auto-mute) leaves it null, and `evaluateStrikeEscalation` will neither lift nor shorten
 * a mute that has it. `processTimedUnmutes` still lifts an expiry on time — that is the point of a timed
 * mute — and clears `mutedAt` with it.
 *
 * The unmute half is `releaseUserMute`, which needs the acting moderator.
 */
export async function setUserMuted(
  args:
    | { userId: number; muted: true; expiresAt?: Date | null }
    | { userId: number; muted: false; actorId: number; activity?: MuteReleaseActivity }
) {
  if (!args.muted) {
    const result = await releaseUserMute({
      userId: args.userId,
      actorId: args.actorId,
      activity: args.activity,
      updateSource: 'retool:unmute',
    });
    if (!result.released) throw new Error(`No user with id ${args.userId}`);
    return result.user;
  }

  const user = await updateUserById({
    id: args.userId,
    data: {
      muted: true,
      mutedAt: new Date(),
      ...(args.expiresAt !== undefined ? { muteExpiresAt: args.expiresAt } : {}),
    },
    updateSource: 'retool:mute',
  });
  const { invalidateSession } = await import('~/server/auth/session-invalidation');
  await invalidateSession(args.userId, 'moderation');
  return user;
}

/**
 * Privileged: set the moderator flag on a user. Caller is responsible for
 * super-admin allowlist gating (handled by RetoolEndpoint).
 *
 * Rejects self-action: a moderator cannot demote (or escalate) themselves —
 * stops mid-flow session strandings and forces the change to go through a
 * second operator with audit trail intact.
 */
export async function setUserModerator({
  userId,
  isModerator,
  actorId,
}: {
  userId: number;
  isModerator: boolean;
  actorId: number;
}) {
  if (userId === actorId) {
    throw new Error('Cannot modify your own moderator status — ask another operator.');
  }
  const user = await updateUserById({
    id: userId,
    data: { isModerator },
    updateSource: 'retool:setModerator',
  });
  const { invalidateSession } = await import('~/server/auth/session-invalidation');
  await invalidateSession(userId, 'admin');
  return user;
}

/**
 * Privileged: forcibly update username / email / display name. Bypasses the
 * "don't overwrite existing email" guard on `updateUserById` because the whole
 * point of this endpoint is letting mods correct identity fields.
 *
 * Uniqueness enforcement is delegated to the DB constraints on User (username
 * + email) — Prisma will throw a P2002 which surfaces as a 500 with the
 * conflicting target.
 */
export async function forceUpdateUserIdentity({
  userId,
  username,
  email,
  name,
}: {
  userId: number;
  username?: string;
  email?: string;
  name?: string;
}) {
  const data: Prisma.UserUpdateInput = {};
  if (username !== undefined) data.username = username;
  if (email !== undefined) data.email = email;
  if (name !== undefined) data.name = name;
  if (Object.keys(data).length === 0) return { updated: false };

  let user;
  try {
    user = await dbWrite.user.update({ where: { id: userId }, data });
  } catch (error) {
    // Translate Prisma unique-constraint violations into a 4xx for callers.
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    ) {
      const target = ((error as { meta?: { target?: string[] } }).meta?.target ?? []).join(', ');
      throw throwBadRequestError(`Unique constraint failed${target ? ` on ${target}` : ''}`);
    }
    throw error;
  }
  userUpdateCounter?.inc({ location: 'user.service:forceUpdateUserIdentity' });

  if (data.username !== undefined || data.name !== undefined) {
    await deleteBasicDataForUser(userId);
    // 🔴 A moderator-forced rename has to reach the search index, and NOTHING else will take
    // it there. The incremental user-index sync scans on `createdAt`, so it never revisits an
    // existing row, and the nightly reconciler only checks whether an id still qualifies — it
    // never refreshes a field. Without this enqueue the index serves the OLD username
    // indefinitely, which is exactly how a renamed account keeps being found (and acted on by
    // id) under the name it was renamed away from. The self-serve profile save has always
    // enqueued this; the moderator path did not.
    // 🔴 NEVER LET THE ENQUEUE BREAK THE RENAME. It is a Redis write, and the rename has
    // already committed by the time it runs — a blip would throw here, BEFORE
    // `invalidateSession` below, leaving the account renamed with its old session still live
    // while the moderator sees a 500. Every other side effect in this file is isolated the
    // same way; a stale search document is the smallest of the failures available here.
    await usersSearchIndex
      .queueUpdate([{ id: userId, action: SearchIndexUpdateQueueAction.Update }])
      .catch((error) =>
        logToAxiom({
          type: 'error',
          name: 'force-update-identity-search-index',
          message: (error as Error).message,
        })
      );
  }

  const { invalidateSession } = await import('~/server/auth/session-invalidation');
  await invalidateSession(userId, 'moderation');

  return { updated: true, user };
}

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
    // Only a user with NO address on file can set one here, so the guard runs on exactly the writes
    // that survive — an existing address was already vetted when it was set.
    if (existingData?.email) delete data.email;
    else if (typeof data.email === 'string') await assertEmailAllowed(data.email);
    else delete data.email;
  }

  if (
    typeof data.browsingLevel === 'number' &&
    Flags.hasFlag(data.browsingLevel, NsfwLevel.Blocked)
  ) {
    data.browsingLevel = Flags.removeFlag(data.browsingLevel, NsfwLevel.Blocked);
  }

  // The account form sends the username on every save; only a real rename is worth a scan.
  const previousUsername =
    typeof data.username === 'string'
      ? (await dbWrite.user.findUnique({ where: { id }, select: { username: true } }))?.username
      : undefined;

  const user = await dbWrite.user.update({ where: { id }, data });

  // Track user update with optional source context
  let location = 'user.service:updateUserById';
  if (updateSource) location += `:${updateSource}`;
  userUpdateCounter?.inc({ location });
  if (typeof data.username === 'string' && data.username !== previousUsername)
    queueScamScan({ entityType: 'User', entityId: id });

  if (data.username !== undefined || data.deletedAt !== undefined || data.image !== undefined) {
    await deleteBasicDataForUser(id);
  }

  if (
    data.showNsfw !== undefined ||
    data.blurNsfw !== undefined ||
    data.browsingLevel !== undefined ||
    data.autoplayGifs !== undefined
  ) {
    await userSettingsCache().bust([id]);
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

export type EngagedModelType = ModelEngagementType | 'Recommended';

/**
 * Per-visible-set engagement membership: given a bounded set of `modelIds`, return which of
 * them the user has engaged with, keyed by engagement type. The additive, index-bounded
 * replacement for `getUserEngagedModels` (whose caller returns a user's ENTIRE engagement
 * history — a whale's 3.75 MB / 482 ms synchronous serialize froze an api-primary pod).
 *
 * Every returned array is a subset of the input `modelIds` (the intersection of the user's
 * engagements ∩ input), so the response is bounded by |modelIds| × (#types) — no cache needed.
 * `Recommended` is derived from resource reviews, filtered to the same input set.
 */
export const getUserEngagedModelsByIds = async ({
  id,
  modelIds,
}: {
  id: number;
  modelIds: number[];
}) => {
  const [engagements, recommendedReviews] = await Promise.all([
    listModelEngagements(kyselyRead, { userId: id, modelIds }),
    // Lazy: a static import here closes the image.service import cycle (no-image-service-import-cycle).
    import('~/server/services/resourceReview.service').then(({ getResourceReviewsByUserId }) =>
      getResourceReviewsByUserId({ userId: id, recommended: true, modelIds })
    ),
  ]);

  const engagedModels = engagements.reduce<Record<EngagedModelType, number[]>>((acc, model) => {
    const { type, modelId } = model;
    if (!acc[type]) acc[type] = [];
    acc[type].push(modelId);
    return acc;
  }, {} as Record<EngagedModelType, number[]>);
  engagedModels.Recommended = recommendedReviews.map((r) => r.modelId).filter(isDefined);

  return engagedModels;
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
  // On the username-search (query) path we replace the exact COUNT with a take+1
  // "hasMore" probe (see the comment in the `count` block below): over-fetch one
  // row so we can tell whether another page exists without running an aggregate.
  const useHasMore = count && !!query && take != null;
  const items = await dbRead.user.findMany({
    take: useHasMore ? (take as number) + 1 : take,
    skip,
    select,
    where,
    orderBy,
  });

  if (count) {
    // ── Username-search path (query present): DROP the exact COUNT ────────────
    // The search count is pathological. `where.username = { contains: query }`
    // compiles to `username LIKE '%query%'` (a leading wildcard no btree can
    // serve) intersected with `models: { some: {} }`. Both sides are
    // non-selective (~90k model-owners, tens-of-thousands of `%q%` matches) with
    // a tiny intersection, so the planner scans the whole ~900k-row Model table →
    // HashAggregate to ~90k distinct owners → nested-loop into User applying the
    // LIKE as a filter: ~800ms–1.4s on EVERY keystroke-driven request, dominating
    // this endpoint's DB latency (~53,000s of replica CPU / 37d in prod). It is
    // also uncacheable: `query` is user-controlled on a public endpoint with no
    // `.max()` in its zod schema, so per-query cache keys are an unbounded
    // keyspace-growth vector.
    //
    // So on the query path we return a `hasMore` boolean derived from the take+1
    // over-fetch instead of a count. The controller maps this to pagination
    // metadata (totalItems/totalPages become monotonic lower-bounds that are
    // exact on the final page; `hasMore` is the authoritative next-page signal
    // and the REST nextPage/prevPage links keep working). The no-query BROWSE
    // path below keeps its cached exact count unchanged.
    if (query) {
      const hasMore = take != null && items.length > (take as number);
      return { items: hasMore ? items.slice(0, take as number) : items, hasMore };
    }
    // ── No-query browse path (unchanged): cached exact count ──────────────────
    // The browse count scans the whole ~900k-row Model table (index-only scan on
    // Model_userId → HashAggregate distinct userIds → nested-loop to User,
    // ~1174ms in EXPLAIN ANALYZE). It's a slowly-moving aggregate, so cache it: a
    // few-minutes-stale totalItems/totalPages is harmless. Cache unconditionally
    // (no IS_DATAPACKET gate) — the scan is expensive on every cluster. TTL =
    // 10min (CacheTTL.md): cheap-to-refresh, bounds staleness to a sub-page drift
    // on an ~86.5k-creator total.
    // No-query path: key by `excludeIds` only (the only remaining varying part of
    // `where`; models:{some:{}} and deletedAt:null are constant).
    const sortedExcludeIds = [...excludeIds].sort((a, b) => a - b).join(',');
    const cacheKey = `${REDIS_KEYS.CACHES.CREATORS_COUNT}:${sortedExcludeIds}` as const;
    // fetchThroughCache is fail-open on a Redis read/lock ERROR (degrades to the
    // origin fetch). But on lock-retry EXHAUSTION (cold key + concurrent burst) it
    // throws 'Failed to fetch data through cache' — fall back to the inline count
    // there too so this endpoint never 500s from the caching machinery. (A genuine
    // dbRead.user.count DB error still propagates — the fallback re-runs and throws
    // again — which matches pre-cache behavior.)
    const cachedCount = await fetchThroughCache(cacheKey, () => dbRead.user.count({ where }), {
      ttl: CacheTTL.md,
    }).catch((e) => {
      // Only the lock-retry-exhaustion throw falls back to the inline count. Any
      // OTHER throw from the cache helper (e.g. a future key-type/serialization
      // invariant) must surface, not be silently swallowed into a count.
      if (!String((e as Error)?.message).includes('Failed to fetch data through cache')) throw e;
      return dbRead.user.count({ where });
    });
    return { items, count: cachedCount };
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

  // Every write is scoped by the `type` the row was READ as, never by the PK alone.
  // `ModelEngagement` holds one row per (user, model) carrying one of
  // Favorite | Hide | Mute | Notify, and the four have no precedence order, so the
  // only guard available is the type this call observed — a writer replaces what it
  // saw or nothing. Unqualified, a Hide arriving here landed on whatever another
  // writer had just established and reported success.
  if (engagement) {
    if (!setTo && engagement.type === type) {
      await dbWrite.modelEngagement.deleteMany({ where: { userId, modelId, type } });
      if (type === 'Hide') await HiddenModels.refreshCache({ userId });
      return false;
    } else if (setTo && engagement.type !== type) {
      const { count } = await dbWrite.modelEngagement.updateMany({
        where: { userId, modelId, type: engagement.type },
        data: { type, createdAt: new Date() },
      });
      // `HiddenModels` is keyed on `type = 'Hide'`, so a conversion in EITHER
      // direction changes the hidden set. Nothing refreshed it here before, leaving
      // a model hidden after the user converted the row to Notify.
      if (count && (type === 'Hide' || engagement.type === 'Hide'))
        await HiddenModels.refreshCache({ userId });
      // Zero rows means a concurrent writer replaced the row we read; it does not
      // carry `type`, and saying otherwise is a claim the caller acts on.
      return count > 0;
    }
    return true; // no change
  } else if (setTo === false) return false;

  await dbWrite.modelEngagement.create({ data: { type, modelId, userId } }).catch((error) => {
    // Toggle racing itself: both calls saw no engagement and both create, so the
    // loser hits the (userId, modelId) unique constraint (P2002). The engagement
    // now exists — a toggle is idempotent, so treat it as success (still run the
    // Hide cache-refresh + return true) instead of bubbling a 500.
    if (!isPrismaUniqueViolation(error)) throw error;
  });
  if (type === 'Hide') await HiddenModels.refreshCache({ userId });
  return true;
};

export const toggleModelNotify = async ({ userId, modelId }: { userId: number; modelId: number }) =>
  toggleModelEngagement({ userId, modelId, type: 'Notify' });

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

  // Every write below is scoped by `type`. The row read a moment ago may already
  // be a different type — a block applied from another tab, say — and an
  // unqualified `delete`/`update` on the PK would take that block with it while
  // reporting success.
  if (engagement) {
    if (engagement.type === 'Follow') {
      await clearUserEngagement({ userId, targetUserId, type: UserEngagementType.Follow });
      await setUserFollowCached({ userId, targetUserId, following: false });
      return false;
    } else if (engagement.type === 'Hide') {
      const { count } = await dbWrite.userEngagement.updateMany({
        where: { userId, targetUserId, type: UserEngagementType.Hide },
        data: { type: UserEngagementType.Follow },
      });
      // Matching nothing does NOT mean "not following". The Hide this call read is
      // gone, and one of the things that can hold the pair instead is a Follow — a
      // second concurrent toggle that won this same `updateMany`. Asserting `false`
      // there writes a WRONG entry that stands for the rest of the day-long TTL,
      // where the refetch merely costs.
      if (count) await setUserFollowCached({ userId, targetUserId, following: true });
      else await userFollowsCache.refresh(userId);
      // This branch REMOVES a Hide, and `HiddenUsers` is keyed on `type = 'Hide'`.
      // Without this the target stays hidden from the feed of the user who just
      // followed them, until the hash TTL expires.
      await HiddenUsers.refreshCache({ userId });
      // Zero rows means the Hide is gone — replaced by a Block, most likely — so
      // no follow was established and saying otherwise would be a lie the caller
      // acts on (reward, notification, tracking event).
      return count > 0;
    }

    return false;
  }

  const ret = await dbWrite.userEngagement
    .create({
      data: { type: 'Follow', targetUserId, userId },
      select: { user: { select: { username: true } } },
    })
    .catch((error) => {
      // Something took the (userId, targetUserId) PK between the read and the
      // insert. Which type it is decides the answer, so read it back below rather
      // than bubble a 500.
      if (!isPrismaUniqueViolation(error)) throw error;
      return null;
    });

  if (!ret) {
    const winner = await dbWrite.userEngagement.findUnique({
      where: { userId_targetUserId: { userId, targetUserId } },
      select: { type: true },
    });
    // Usually the toggle racing itself, and the winner already sent the
    // follow-notification (deduped by `key`) — but the row can equally be a Block,
    // which outranks a Follow. Returning true there tells the user they follow
    // someone they do not, and pays a follow reward for it.
    const followed = winner?.type === UserEngagementType.Follow;
    await setUserFollowCached({ userId, targetUserId, following: followed });
    return followed;
  }

  await setUserFollowCached({ userId, targetUserId, following: true });

  {
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
  }

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

export const deleteUser = async ({ id, username, removeModels, removeImages }: DeleteUserInput) => {
  const user = await dbWrite.user.findFirst({
    where: { username, id },
    select: { id: true, meta: true },
  });
  if (!user) throw throwNotFoundError('Could not find user');
  // Here rather than in each caller, so every caller of `deleteUser` is held to it. The scrub below
  // checks again in the same statement as its write.
  const { markerView } = await assertAccountNotUnderLegalHold(user.id);

  const modelData: Prisma.ModelUpdateManyArgs['data'] = removeModels
    ? { deletedAt: new Date(), status: 'Deleted' }
    : { userId: -1 };

  const meta = { ...((user.meta ?? {}) as UserMeta), imageRemoval: imageRemovalMode(removeImages) };

  const result = await dbWrite
    .$transaction([
      // A hold that landed after the check above fails this statement, and with it the whole
      // transaction, so nothing else in it commits. It also clears "subscriptionId", which no Prisma delegate reaches: a second pointer to
      // the billing record (subscription -> customer -> charges) that outlives paddleCustomerId.
      dbWrite.$executeRaw(guardedAccountScrubSql(user.id, markerView)),
      ...(removeModels
        ? []
        : [
            dbWrite.$executeRaw(recordCurrentModelOwnersSql(Prisma.sql`m."userId" = ${user.id}`)),
            dbWrite.$executeRaw(
              recordModelOwnershipSql({
                where: Prisma.sql`m."userId" = ${user.id}`,
                userId: PLACEHOLDER_OWNER_ID,
                reason: 'account-delete',
              })
            ),
          ]),
      dbWrite.model.updateMany({ where: { userId: user.id }, data: modelData }),
      dbWrite.account.deleteMany({ where: { userId: user.id } }),
      dbWrite.session.deleteMany({ where: { userId: user.id } }),
      // Two OR elements, not one carrying two fields — that is a single ANDed
      // predicate (`userId = X AND targetUserId = X`), which matches only a
      // self-engagement row and so deleted nothing. `deleteUser` soft-deletes the User
      // row, so no FK cascade covers for it: every follow and hide of a deleted account
      // survived and kept being counted by `getUserList`.
      //
      // Blocks are EXEMPT, in both directions. This delete is reversible — `restoreUser`
      // brings the account back and restores nothing here — so clearing a Block would
      // silently switch off a safety control that someone else set, with no event
      // telling them. A Follow or a Hide is list noise; a Block is not.
      dbWrite.userEngagement.deleteMany({
        where: {
          OR: [{ userId: user.id }, { targetUserId: user.id }],
          type: { not: UserEngagementType.Block },
        },
      }),
      // deleteMany, not delete: most accounts have no row here, and `delete` throws on a
      // miss. The FK cascade never fires for either of these because this is a SOFT delete.
      dbWrite.userProfile.deleteMany({ where: { userId: user.id } }),
      dbWrite.userLink.deleteMany({ where: { userId: user.id } }),
      // The rest of the scrub is in `guardedAccountScrubSql`; meta is here because it carries the
      // account's own data, which the guarded statement cannot take as a parameter.
      dbWrite.user.update({ where: { id: user.id }, data: { meta } }),
    ])
    .catch((e) => {
      if (isLegalHoldAbort(e)) throw new LegalHoldError();
      throw e;
    });

  userUpdateCounter?.inc({ location: 'user.service:deleteUser' });
  void syncOwnerEventHats(user.id);
  void syncEventRosterMember(user.id);

  // The account is deleted from here on. A failing step must not skip a later one (a skipped
  // cancel keeps billing a user who can no longer log in to stop it), and must not surface as
  // an error: the user would read a completed deletion as a failed one and retry.
  const runStep = async (step: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      await logToAxiom({
        name: step,
        type: 'error',
        source: 'deleteUser',
        userId: user.id,
        message: (error as Error)?.message,
      }).catch(() => null);
    }
  };

  await runStep('invalidate-session', () => invalidateSession(id, 'moderation'));
  await runStep('cancel-stripe-subscription', () =>
    cancelSubscription({ userId: user.id, removeRecord: true })
  );

  // The engagement rows are gone for real now, so the deleted user's own follow set
  // has to go with them. Their FOLLOWERS' caches are deliberately left to expire on
  // their own TTL — a popular account has six figures of them, and what each holds
  // is an id whose content this same call has already removed.
  await runStep('bust-follows-cache', () => userFollowsCache.bust(user.id));
  await runStep('search-index-delete', () =>
    usersSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }])
  );
  await runStep('delete-basic-data', () => deleteBasicDataForUser(id));
  await runStep('refresh-profile-picture', () => refreshProfilePicturesForUsers([user.id]));
  await runStep('close-pending-restrictions', () =>
    closeGenerationRestrictionsOfDeletedAccount(user.id)
  );

  // Last: when a Paddle subscription row exists this calls Paddle, whose client has no timeout.
  await runStep('cancel-paddle-subscription', () => cancelSubscriptionPlan({ userId: user.id }));

  return result;
};

export async function setLeaderboardEligibility({ id, setTo }: { id: number; setTo: boolean }) {
  await dbWrite.$executeRawUnsafe(`
    UPDATE "User"
    SET "excludeFromLeaderboards" = ${setTo}
    WHERE id = ${id}
  `);
  userUpdateCounter?.inc({ location: 'user.service:setLeaderboardEligibility' });
  void syncOwnerEventHats(id);
  void syncEventRosterMember(id);
}

/**
 * Restore a soft-deleted user account (the inverse of deleteUser).
 *
 * deleteUser scrubs username, email, name, paddleCustomerId, subscriptionId, image,
 * profilePictureId from the User row and sets deletedAt. subscriptionId is not restored, and
 * do NOT read that as "the subscription is gone": the cancels below run through runStep, which
 * swallows, the Paddle one never deletes the CustomerSubscription row, and the Stripe one only
 * deletes it for an active/past_due/trialing row. 6,816 soft-deleted accounts hold a surviving
 * row today, 96 of them still live (prod, 2026-09-21). Check the billing record independently. It also hard-deletes Account / Session / UserProfile / UserLink
 * rows and every
 * UserEngagement row the account appears in EXCEPT Blocks — those survive precisely so
 * a restore cannot leave someone unblocked without telling them — and reassigns
 * the user's Models to userId = -1.
 * We can only restore what survives the deletion: the User row's scrubbed fields (caller
 * supplies them) and the orphaned Model ownership (via ClickHouse audit).
 *
 * Images depend on the removal the user chose (`meta.imageRemoval`):
 * - `immediate` — remove-deleted-user-images hard-deletes them, S3 objects included, as it
 *   reaches the account. Whatever it already took is gone; the rest survive from here on.
 * - `grace` — that job hides them instead and arms a 7-day purge. This function reverses both,
 *   so restoring inside the window brings the images back.
 * Posts are hard-deleted on the immediate path only and are not recoverable.
 *
 * UserProfile and UserLink rows are unrecoverable too, so a restored account comes back with an
 * empty profile. Nothing restores name.
 *
 * Account (OAuth links) and Session rows are unrecoverable; the user signs in fresh post-restore
 * (email magic-link or OAuth) which creates new rows.
 */
export const restoreUser = async ({ id, username, email, restoreModels }: RestoreUserInput) => {
  const user = await dbWrite.user.findFirst({
    where: { id },
    select: { id: true, deletedAt: true, meta: true },
  });
  if (!user) throw throwNotFoundError(`No user with id ${id}`);
  if (!user.deletedAt) throw throwBadRequestError(`User ${id} is not deleted; nothing to restore`);

  // Make sure the username and email aren't claimed by some other user since the closure.
  const conflict = await dbWrite.user.findFirst({
    where: { id: { not: id }, OR: [{ username }, { email }] },
    select: { id: true, username: true, email: true },
  });
  if (conflict) {
    throw throwBadRequestError(
      `Cannot restore: username or email is already in use by user ${conflict.id}`
    );
  }

  // The models the account created, for those with no recorded owner but the placeholder (ClickHouse
  // lives outside Postgres, so read up front). A Create event's actor is the model's creator; every
  // other event's actor may be a moderator. A model transferred since was not this account's when it
  // went to the placeholder, and the event does not say to whom it went, so it is left out.
  let createdIds: number[] = [];
  if (restoreModels) {
    const createdRows =
      (await clickhouse?.$query<{ modelId: number }>(`
        SELECT DISTINCT modelId
        FROM modelEvents
        WHERE userId = ${id} AND type = 'Create'
      `)) ?? [];
    const created = createdRows.map((r) => Number(r.modelId)).filter(Number.isInteger);
    const transferred = new Set<number>();
    for (const ids of chunkIds(created, 5000)) {
      const rows =
        (await clickhouse?.$query<{ modelId: number }>(`
          SELECT DISTINCT modelId
          FROM modelEvents
          WHERE type = 'Transfer' AND modelId IN (${ids.join(',')})
        `)) ?? [];
      for (const r of rows) transferred.add(Number(r.modelId));
    }
    createdIds = created.filter((modelId) => !transferred.has(modelId));
  }

  // Reclaim orphaned models BEFORE flipping deletedAt. We deliberately avoid wrapping the user and
  // model writes in one transaction: a user can own thousands of models, and an interactive
  // transaction would hold a connection + row locks open across the whole set (and risk Prisma's
  // 5s timeout). Doing it first also keeps the operation re-runnable — if it fails, deletedAt is
  // still set, so a retry passes the guard above instead of being locked out.
  //
  // The deletion path (removeModels:false) sets Model.userId = -1 without touching status/deletedAt,
  // so only those orphans are reclaimed, and only those whose last recorded owner before the
  // placeholder is this account. Models deleted via removeModels:true keep their userId and get
  // status='Deleted' instead — they are intentionally NOT restored here.
  let modelsRestored = 0;
  let restoredModelIds: number[] = [];
  if (restoreModels) {
    const orphans = await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT m.id
      FROM "Model" m
      WHERE m."userId" = -1
        AND m.id IN (
          SELECT o."modelId" FROM "ModelOwnership" o WHERE o."userId" = ${id}
          UNION
          SELECT unnest(${createdIds}::int[])
        )
        AND COALESCE(
          (
            SELECT o."userId" FROM "ModelOwnership" o
            WHERE o."modelId" = m.id AND o."userId" <> -1
            ORDER BY o.id DESC
            LIMIT 1
          ),
          CASE WHEN m.id = ANY(${createdIds}::int[]) THEN ${id}::int END
        ) = ${id}
      ORDER BY m.id
    `;
    restoredModelIds = orphans.map((m) => m.id);

    if (restoredModelIds.length > 0) {
      const [updated] = await dbWrite.$transaction([
        dbWrite.model.updateMany({
          where: { id: { in: restoredModelIds }, userId: -1 },
          data: { userId: id },
        }),
        dbWrite.$executeRaw(
          recordModelOwnershipSql({
            where: Prisma.sql`m.id = ANY(${restoredModelIds}::int[]) AND m."userId" = ${id}`,
            userId: id,
            reason: 'restore',
          })
        ),
      ]);
      modelsRestored = updated.count;
    }
  }

  // The scrub's retry state goes with the deletion it belonged to. Left behind, a re-deleted
  // account would inherit its old attempt count, so its first failure would already be backed off
  // for hours and it would alert as stuck long before it is.
  const {
    imageRemoval: _removalChoice,
    gdprStripeScrub: _scrubState,
    ...meta
  } = (user.meta ?? {}) as UserMeta;

  // Deliberately NOT domain-guarded, same exempt class as `forceUpdateUserIdentity`: this is a
  // moderator putting back the address a closed account already had, and re-judging it against a
  // list that moved since would make some accounts unrestorable.
  await dbWrite.$transaction([
    dbWrite.user.update({
      where: { id },
      data: { deletedAt: null, username, email, meta },
    }),
    disarmAccountDeletionImagePurge(id),
  ]);

  // The account is restored at this point: a throw would read as a failed restore, and a retry is refused.
  await reopenGenerationRestrictionsOfRestoredAccount(id).catch((error) =>
    logToAxiom({
      name: 'reopen-pending-restrictions',
      type: 'error',
      source: 'restoreUser',
      userId: id,
      message: (error as Error)?.message,
    }).catch(() => null)
  );

  // Queued after the clear: `restore-user-images` acts only on an account whose `deletedAt`
  // already reads NULL, and the drain job's gates can no longer re-hide what it unblocks.
  const imagesPendingRestore = await countPendingAccountDeletionImageRestores(id);
  if (imagesPendingRestore > 0) await recordPendingImageRestore(id);

  userUpdateCounter?.inc({ location: 'user.service:restoreUser' });
  void syncOwnerEventHats(id);
  void syncEventRosterMember(id);
  await usersSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);
  // deleteUser refreshes userBasicCache (username/deletedAt/image, 1-day TTL) after scrubbing the
  // row; mirror that here so the restored identity is visible immediately instead of serving the
  // stale "deleted" values until the cache expires.
  await deleteBasicDataForUser(id);
  // The sale badge only counts a sale whose owner owns the model, so while these models sat at
  // userId -1 the cache recorded "no sale" for them, and that marker outlives a short TTL. Best-effort:
  // the restore has committed, so a failed bust is logged rather than failing it.
  try {
    await bustModelSaleCacheForModels(restoredModelIds);
  } catch (error) {
    logToAxiom({
      name: 'restore-user-model-sale-cache',
      type: 'error',
      source: 'restoreUser',
      userId: id,
      message: (error as Error)?.message,
    }).catch(() => null);
  }

  return {
    id,
    username,
    email,
    modelsRestored,
    modelIds: restoredModelIds,
    imagesPendingRestore,
  };
};

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
    // Skip toggleBan's Moderated media block; softDeleteUser applies its own
    // CSAM block below. Avoids a redundant double-write and a Moderated->CSAM
    // flip. Not `removeMedia: false`, which a minor-safety ban ignores.
    // Models still unpublish (removeModels defaults on).
    mediaBlockedByCaller: true,
  });

  await dbWrite.image.updateMany({
    where: { userId: id },
    data: {
      ingestion: 'Blocked',
      nsfwLevel: NsfwLevel.Blocked,
      blockedFor: BlockedReason.CSAM,
    },
  });
  // A CSAM block outranks an account-deletion grace block. If this account had already
  // self-deleted with the grace option, every image carries the restore breadcrumbs; left on, a
  // later restore would un-block CSAM-blocked content.
  //
  // Account-wide here, unlike the ban branch in `toggleBan`: the UPDATE above carries no
  // `ingestion` predicate, so it blocked EVERY image this user owns. The clear's scope and the
  // block's scope are the same set, which is what makes the wide form correct in this one place.
  await clearAccountDeletionImageMarkers({ userId: id });
  await refreshProfilePicturesForUsers([id]);

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

/** The listed ids whose row no longer exists, read on the primary. */
async function goneIds(table: 'Model' | 'Article' | 'Collection' | 'Bounty', ids: number[]) {
  if (!ids.length) return [];
  const left = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ANY(${ids}::int[])`;
  const kept = new Set(left.map((r) => r.id));
  return ids.filter((i) => !kept.has(i));
}

/** The listed models that no longer exist or are no longer published, read on the primary. */
async function modelsOffSite(ids: number[]) {
  if (!ids.length) return [];
  const published = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT id FROM "Model" WHERE id = ANY(${ids}::int[]) AND status = 'Published'`;
  const live = new Set(published.map((r) => r.id));
  return ids.filter((i) => !live.has(i));
}

/**
 * Of the listed models, read on the primary, those a wipe deleted and those it kept and hid: still
 * in the hidden status and carrying the wipe's record. A model a moderator took down for a
 * violation is in the same status without the record, and its bids stand.
 */
async function removedModels(ids: number[]) {
  if (!ids.length) return { gone: [], hidden: [] };
  const left = await dbWrite.$queryRaw<{ id: number; hidden: boolean }[]>`
    SELECT id, (status = ${Prisma.raw(`'${KEPT_MODEL_STATUS}'`)}
      AND meta ->> 'removedWithOwner' = 'true') IS TRUE AS hidden
    FROM "Model" WHERE id = ANY(${ids}::int[])`;
  const present = new Set(left.map((r) => r.id));
  return {
    gone: ids.filter((i) => !present.has(i)),
    hidden: left.filter((r) => r.hidden).map((r) => r.id),
  };
}

/** Drops the caches that would still serve a hidden model as published: its status was a raw write. */
async function dropHiddenModelCaches(modelIds: number[], userId: number) {
  const versions = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT id FROM "ModelVersion" WHERE "modelId" = ANY(${modelIds}::int[])`;
  // Imported here: a static import joins user.service to the model-version import cycle.
  const { bustMvCache } = await import('~/server/services/model-version.service');
  await bustMvCache(
    versions.map((v) => v.id),
    modelIds,
    userId
  );
  await userContentOverviewCache.refresh(userId);
}

/** Queues a search-index Delete for each listed row that no longer exists. */
async function unindexDeleted(
  lists: [
    { queueUpdate: typeof modelsSearchIndex.queueUpdate },
    'Model' | 'Article' | 'Collection' | 'Bounty',
    { id: number }[]
  ][]
) {
  for (const [index, table, rows] of lists) {
    const gone = await goneIds(
      table,
      rows.map((r) => r.id)
    );
    if (gone.length)
      await index.queueUpdate(
        gone.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Delete }))
      );
  }
}

// With `modelIds` when it could not be read which models went: its versions are only candidates
// to check, never `versionIds` to refund, since a model a hold kept still holds live bids.
type BidRefundFailure =
  | { versionIds: number[]; transactionIds?: string[]; error?: string }
  | { modelIds: number[]; candidateVersionIds: number[]; error: string };

/**
 * Refunds the bids on the models the wipe deleted or kept and hid; a model a hold kept and left
 * public keeps its bids. Versions are passed by id because a deleted model's row is gone. Never
 * throws: a re-run of the wipe finds no deleted models to refund, so each failure is logged as its
 * own `bid-refund-failed` line (alerted on) with the ids a manual refund needs, or the candidates to
 * check when it could not tell which models went, and returned.
 */
async function refundBidsForRemovedModels(
  models: { id: number; name: string; modelVersions: { id: number }[] }[],
  wipe: { userId: number; actorUserId: number | null }
): Promise<BidRefundFailure[]> {
  const failures = await refundEachRemovedModel(models);
  for (const failure of failures)
    logToAxiom({
      name: 'bid-refund-failed',
      type: 'error',
      message:
        'modelIds' in failure
          ? 'A content wipe could not tell which models it deleted; check which candidates are gone before refunding any bids'
          : 'A content wipe could not refund bids; refund them by hand',
      source: 'remove-all-content',
      userId: wipe.userId,
      moderatorId: wipe.actorUserId,
      ...failure,
    }).catch(() => undefined);
  return failures;
}

async function refundEachRemovedModel(
  models: { id: number; name: string; modelVersions: { id: number }[] }[]
): Promise<BidRefundFailure[]> {
  const versionIdsOf = (m: (typeof models)[number]) => m.modelVersions.map((v) => v.id);
  let removed: Set<number>;
  try {
    const { gone, hidden } = await removedModels(models.map((m) => m.id));
    removed = new Set([...gone, ...hidden]);
  } catch (e) {
    return [
      {
        modelIds: models.map((m) => m.id),
        candidateVersionIds: models.flatMap(versionIdsOf),
        error: (e as Error).message,
      },
    ];
  }
  const failures: BidRefundFailure[] = [];
  for (const m of models) {
    if (!removed.has(m.id)) continue;
    const versionIds = versionIdsOf(m);
    try {
      const { refundFailed } = await refundBidsForVersions({
        versionIds,
        name: m.name,
        notificationKey: m.id,
      });
      if (refundFailed.length) failures.push({ versionIds, transactionIds: refundFailed });
    } catch (e) {
      failures.push({ versionIds, error: (e as Error).message });
    }
  }
  return failures;
}

/**
 * Moderator hard-wipe of a user's content. IRREVERSIBLE — unlike `deleteUser`
 * above, which soft-deletes and has a live inverse in `restoreUser`.
 *
 * `actorUserId` is the acting moderator when one exists. It is OPTIONAL because
 * one of the two callers genuinely has no user identity: `/api/mod/remove-all-
 * content` is a `WebhookEndpoint`, authenticated by a shared secret, so there is
 * no actor to thread. The tRPC caller (`user.removeAllContent`, a
 * `moderatorProcedure`) passes `ctx.user.id`.
 */
export const removeAllContent = async ({
  id,
  actorUserId = null,
  claimedModeratorId = null,
}: {
  id: number;
  actorUserId?: number | null;
  /** The webhook caller's unverified say-so; named on alerts only, never written as an actor. */
  claimedModeratorId?: number | null;
}) => {
  const alertedBy = { userId: id, actorUserId: actorUserId ?? claimedModeratorId };
  // Here rather than in each caller (tRPC, the webhook, the moderator app's purge), so every one is
  // held to it. The deletes that destroy evidence check again in their own statements.
  const { markerView } = await assertAccountNotUnderLegalHold(id);
  const held = accountHoldSql(Prisma.sql`${id}::int`, markerView);

  // The primary, as the deletes below: a row the replica has not seen yet is still deleted.
  const models = await dbWrite.model.findMany({
    where: { userId: id },
    select: { id: true, name: true, modelVersions: { select: { id: true } } },
  });
  const images = await dbWrite.image.findMany({
    where: { userId: id },
    select: { id: true, url: true },
  });
  const articles = await dbWrite.article.findMany({ where: { userId: id }, select: { id: true } });
  const collections = await dbWrite.collection.findMany({
    where: { userId: id },
    select: { id: true },
  });

  // sort deletes by least impactful to most impactful
  await dbWrite.imageReaction.deleteMany({ where: { userId: id } });
  await dbWrite.articleReaction.deleteMany({ where: { userId: id } });
  await dbWrite.commentReaction.deleteMany({ where: { userId: id } });
  await dbWrite.commentV2Reaction.deleteMany({ where: { userId: id } });
  // Deleting a bounty cascades the supporter rows an unsettled award or refund is paid from.
  const unsettled = await dbWrite.bounty.findMany({
    // `isPayoutPending` as a query; keep the two in step.
    where: { userId: id, payoutRecordedAt: { not: null }, payoutSettledAt: null },
    select: { id: true },
  });
  const keptBountyIds: number[] = [];
  if (unsettled.length) {
    const { settleBountyPayout, refundUnpayableBountyAward } = await import(
      '~/server/services/bounty.service'
    );
    for (const { id: bountyId } of unsettled)
      if (!(await settleBountyPayout(bountyId)) && !(await refundUnpayableBountyAward(bountyId)))
        keptBountyIds.push(bountyId);
    if (keptBountyIds.length)
      logToAxiom({
        name: 'remove-all-content',
        type: 'error',
        message: 'Kept bounties whose payout is not settled',
        userId: id,
        bountyIds: keptBountyIds,
      }).catch(() => undefined);
  }
  // Read on the primary with the delete's own filter, so the index loses exactly what is deleted.
  const bounties = await dbWrite.bounty.findMany({
    where: { userId: id, id: { notIn: keptBountyIds } },
    select: { id: true },
  });
  await dbWrite.userLink.deleteMany({ where: { userId: id } });
  await dbWrite.userProfile.deleteMany({ where: { userId: id } });
  await dbWrite.collection.deleteMany({ where: { userId: id } });

  // Evidence: each delete repeats the hold, so one that lands after the check above deletes nothing
  // here. The rows above stay deleted in that case; they are not evidence. Bounties, entries,
  // answers, questions and reviews are here because each cascades its comment thread.
  const unlessHeld = Prisma.sql`NOT ${held}`;
  let stopped: boolean;
  try {
    await dbWrite.$executeRaw`
      DELETE FROM "BountyEntry" be
      WHERE be."userId" = ${id}
        AND NOT EXISTS (SELECT 1 FROM "BountyBenefactor" bb WHERE bb."awardedToId" = be.id)
        AND ${unlessHeld}`;
    await dbWrite.$executeRaw`
      DELETE FROM "Bounty"
      WHERE "userId" = ${id} AND id <> ALL(${keptBountyIds}::int[]) AND ${unlessHeld}`;
    await dbWrite.$executeRaw`DELETE FROM "Answer" WHERE "userId" = ${id} AND ${unlessHeld}`;
    await dbWrite.$executeRaw`DELETE FROM "Question" WHERE "userId" = ${id} AND ${unlessHeld}`;
    await dbWrite.$executeRaw`DELETE FROM "ResourceReview" WHERE "userId" = ${id} AND ${unlessHeld}`;
    await dbWrite.$executeRaw`DELETE FROM "CommentV2" WHERE "userId" = ${id} AND ${unlessHeld}`;
    await dbWrite.$executeRaw`DELETE FROM "Comment" WHERE "userId" = ${id} AND ${unlessHeld}`;
    await dbWrite.$executeRaw`DELETE FROM "Article" WHERE "userId" = ${id} AND ${unlessHeld}`;
    await dbWrite.$executeRaw`DELETE FROM "Post" WHERE "userId" = ${id} AND ${unlessHeld}`;
    // A model is also kept while any owner it had before is held.
    await dbWrite.$executeRaw`
      DELETE FROM "Model"
      WHERE "userId" = ${id} AND ${unlessHeld}
        AND id NOT IN (${heldModelIdsSql(
          Prisma.sql`SELECT om.id FROM "Model" om WHERE om."userId" = ${id}`,
          markerView
        )})`;
    // Status only: the unpublish flow stamps meta.unpublishedAt, which notifies the owner.
    await dbWrite.$executeRaw`
      WITH hidden AS (
        UPDATE "Model" km
        SET status = CASE WHEN km.status IN ('Published', 'Scheduled', 'Unpublished')
                       THEN ${Prisma.raw(`'${KEPT_MODEL_STATUS}'`)} ELSE km.status END,
            meta = ${asJsonbObjectSql('km.meta')} || jsonb_build_object(
              'removedWithOwner', true,
              'statusBeforeRemoval', km.status,
              'versionsUnpublishedByRemoval', COALESCE((
                SELECT jsonb_agg(jsonb_build_object('id', kv.id, 'status', kv.status) ORDER BY kv.id)
                FROM "ModelVersion" kv
                WHERE kv."modelId" = km.id AND kv.status IN ('Published', 'Scheduled')
                  AND km.status IN ('Published', 'Scheduled', 'Unpublished')
              ), '[]'::jsonb)
            )
        -- A draft or a model in training keeps its status: the record alone stops its owner
        -- publishing it. One a moderator took down or deleted needs neither.
        WHERE km."userId" = ${id} AND km.status NOT IN ('UnpublishedViolation', 'Deleted')
          AND ${unlessHeld}
        RETURNING km.id, km.meta
      )
      UPDATE "ModelVersion" mv SET status = 'Unpublished'
      FROM hidden h, jsonb_array_elements(h.meta -> 'versionsUnpublishedByRemoval') taken
      WHERE mv."modelId" = h.id AND mv.id = (taken ->> 'id')::int
        AND mv.status IN ('Published', 'Scheduled')`;
    await dbWrite.$executeRaw`DELETE FROM "ChatMessage" WHERE "userId" = ${id} AND ${unlessHeld}`;
    await dbWrite.$executeRaw`DELETE FROM "ChatMember" WHERE "userId" = ${id} AND ${unlessHeld}`;
    // Rows, storage objects and caches; then any image uploaded since the list was read.
    await deleteImages(
      images.map((i) => i.id),
      true,
      { onlyWhere: unlessHeld }
    );
    await dbWrite.$executeRaw`DELETE FROM "Image" WHERE "userId" = ${id} AND ${unlessHeld}`;
    await refreshProfilePicturesForUsers([id]);

    // A hold that landed mid-wipe stopped the deletes above without an error.
    const [after] = await dbWrite.$queryRaw<{ held: unknown }[]>`SELECT ${held} AS held`;
    stopped = after?.held !== false;
  } catch (e) {
    if (!isLegalHoldAbort(e)) throw e;
    stopped = true;
  }

  // Report it, drop from the indexes only what really went, and leave the apps store alone.
  if (stopped) {
    logToAxiom({
      name: 'remove-all-content',
      type: 'error',
      message: 'Stopped by a legal hold placed during the wipe',
      userId: id,
    }).catch(() => undefined);
    await unindexDeleted([
      [articlesSearchIndex, 'Article', articles],
      [collectionsSearchIndex, 'Collection', collections],
      [bountiesSearchIndex, 'Bounty', bounties],
    ])
      .then(async () => {
        // A stop after the hide leaves hidden models: they leave search with the deleted ones.
        const offSite = await modelsOffSite(models.map((m) => m.id));
        if (offSite.length)
          await modelsSearchIndex.queueUpdate(
            offSite.map((modelId) => ({ id: modelId, action: SearchIndexUpdateQueueAction.Delete }))
          );
      })
      .catch((e: unknown) =>
        logToAxiom({
          name: 'remove-all-content',
          type: 'error',
          message: `Unindexing after a stopped wipe failed: ${(e as Error).message}`,
          userId: id,
        }).catch(() => undefined)
      );
    await refundBidsForRemovedModels(models, alertedBy);
    await removedModels(models.map((m) => m.id))
      .then(async ({ hidden }) => {
        if (hidden.length) await dropHiddenModelCaches(hidden, id);
      })
      .catch((e: unknown) =>
        logToAxiom({
          name: 'remove-all-content',
          type: 'error',
          message: `Dropping hidden models' caches after a stopped wipe failed: ${
            (e as Error).message
          }`,
          userId: id,
        }).catch(() => undefined)
      );
    throw new LegalHoldStoppedError();
  }

  // The main-database wipe is done. A step that throws is logged and named in `incomplete`, and the
  // next step still runs; only the hold re-check below stops the rest.
  const incomplete: string[] = [];
  const failed = (step: string, message: string, details?: Record<string, unknown>) => {
    incomplete.push(step);
    logToAxiom({
      name: 'remove-all-content',
      type: 'error',
      message: `Step failed after the wipe: ${message}`,
      step,
      userId: id,
      ...details,
    }).catch(() => undefined);
  };
  const runStep = async (step: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      failed(step, (error as Error)?.message);
    }
  };
  const unindex = (step: string, index: typeof modelsSearchIndex, rows: { id: number }[]) =>
    runStep(step, () =>
      index.queueUpdate(
        rows.map((r) => ({ id: r.id, action: SearchIndexUpdateQueueAction.Delete }))
      )
    );

  // A model an earlier owner of which is held was kept, hidden: every model leaves search, and the
  // caller is told which were kept.
  let keptModelIds: number[] = [];
  await runStep('index-models', async () => {
    const gone = await goneIds(
      'Model',
      models.map((m) => m.id)
    );
    const goneSet = new Set(gone);
    keptModelIds = models.map((m) => m.id).filter((modelId) => !goneSet.has(modelId));
    if (models.length)
      await modelsSearchIndex.queueUpdate(
        models.map((m) => ({ id: m.id, action: SearchIndexUpdateQueueAction.Delete }))
      );
  });
  if (keptModelIds.length)
    await runStep('kept-model-caches', () => dropHiddenModelCaches(keptModelIds, id));
  else await runStep('content-counts', () => userContentOverviewCache.refresh(id));
  await unindex('index-images', imagesSearchIndex, images);
  await unindex('index-image-metrics', imagesMetricsSearchIndex, images);
  await unindex('index-articles', articlesSearchIndex, articles);
  await unindex('index-collections', collectionsSearchIndex, collections);
  await unindex('index-bounties', bountiesSearchIndex, bounties);
  await unindex('index-user', usersSearchIndex, [{ id }]);

  await runStep('user-metrics', () => userMetrics.queueUpdate(id));
  await runStep('article-metrics', () => articleMetrics.queueUpdate(articles.map((a) => a.id)));

  const refundFailures = await refundBidsForRemovedModels(models, alertedBy);
  if (refundFailures.length) failed('bid-refunds', 'some bids were not refunded');

  // The two stores below are separate databases, so no statement there can carry the hold: check
  // again before either.
  await assertAccountNotUnderLegalHold(id).catch(() => {
    logToAxiom({
      name: 'remove-all-content',
      type: 'error',
      message: 'Stopped by a legal hold before the App Blocks stores',
      userId: id,
    }).catch(() => undefined);
    throw new LegalHoldStoppedError();
  });

  // ── App Blocks per-user storage ─────────────────────────────────────────────
  // A user's App Storage rows live in per-app `app_<slug>` schemas in the separate
  // apps database, so nothing above this point reaches them.
  //
  // 🔴 LAST, AND LOG-AND-CONTINUE: the main-database wipe is already complete and
  // no transaction spans the two databases, so a failure here is logged and named
  // in `incomplete`, never thrown. Recover by hand with
  // `apps.mod.userStorage.purgeAccount`.
  //
  // Dynamic import: this module is already enormous and the purge service pulls in
  // the apps-db pool, which nothing else on this path needs.
  //
  // The purge writes its audit row before deleting anything; keep it that way.
  //
  // 🔴 READ THE RESULT, DO NOT ONLY CATCH. The sweep resolves even when apps fail
  // (they land in `failures[]`), so a bare try/catch sees a clean resolve.
  try {
    const { purgeUserAppStorageForAccountWipe } = await import(
      '~/server/services/apps/user-storage-purge.service'
    );
    const result = await purgeUserAppStorageForAccountWipe({ targetUserId: id, actorUserId });
    if (result.failures.length > 0) {
      failed('app-storage', `${result.failures.length} app(s) failed`);
      // eslint-disable-next-line no-console
      console.warn(
        `[removeAllContent] App Blocks per-user storage purge INCOMPLETE (userId=${id}): ` +
          `${result.failures.length} app(s) failed, ${result.totals.appCount} purged. ` +
          `The content wipe COMPLETED and is unaffected — re-run via ` +
          `apps.mod.userStorage.purgeAccount. Failures: ` +
          result.failures
            .map((f) => `${f.slug}(${f.auditEventId ?? 'no-audit-row'}): ${f.error}`)
            .join('; ')
      );
    }
    if (result.schemasTruncated) {
      // The THIRD way the sweep can complete having deliberately skipped rows,
      // alongside `failures[]` and `unmappedSchemas[]`. Unreachable today (the cap
      // is 500 against ~20 schemas), but a reader of this block would reasonably
      // assume all three conditions are covered, and two of three is how the next
      // silent partial wipe happens.
      // 🔴 DO NOT tell the operator to re-run `purgeAccount` here. That path
      // enumerates the same `information_schema` names, `.sort()`s them and takes
      // the same `.slice(0, MAX)` — so a re-run drops exactly the same schemas,
      // deterministically, forever. (Re-running genuinely does help for
      // `failures[]`, which is transient, and the `unmappedSchemas` warning
      // correctly asks for a human; this one needed its own remedy.)
      failed('app-storage-truncated', 'schema sweep hit its candidate cap');
      // eslint-disable-next-line no-console
      console.warn(
        `[removeAllContent] App Blocks per-user storage: the schema sweep for userId=${id} ` +
          `hit its candidate cap, so some schemas were NOT examined — and re-running ` +
          `purgeAccount would skip the SAME ones (the candidate list is sorted and ` +
          `truncated deterministically). Purge the remaining apps individually via ` +
          `apps.mod.userStorage.purgeApp, or raise APP_USER_STORAGE_MAX_SCHEMAS. ` +
          `NOTE: purgeApp records as a MODERATOR purge, so its audit row keeps the ` +
          `per-key snapshot (key names, sizes, md5 fingerprints) that the wipe path ` +
          `deliberately withholds for an erased account — prefer raising the cap.`
      );
    }
    if (result.unmappedSchemas.length > 0) {
      // Reported separately because it is a different condition with a different
      // remedy: these schemas hold the user's rows but map to no single AppBlock,
      // so the sweep deliberately skipped them and they need a human.
      failed('app-storage-unmapped', `${result.unmappedSchemas.length} unmapped schema(s)`);
      // eslint-disable-next-line no-console
      console.warn(
        `[removeAllContent] App Blocks per-user storage: ${result.unmappedSchemas.length} ` +
          `schema(s) hold rows for userId=${id} but map to no single app block and were SKIPPED: ` +
          result.unmappedSchemas.join(', ')
      );
    }
  } catch (err) {
    // The enumeration-stage faults only — a dead apps DB, a bad pool checkout.
    failed('app-storage', err instanceof Error ? err.message : String(err));
    // eslint-disable-next-line no-console
    console.warn(
      `[removeAllContent] App Blocks per-user storage purge failed (userId=${id}); ` +
        `the content wipe COMPLETED and is unaffected — re-run via apps.mod.userStorage.purgeAccount: ${
          err instanceof Error ? err.message : String(err)
        }`
    );
  }

  const docStoreError = await wipeAccountFromDocStore(id);
  if (docStoreError) failed('doc-store', docStoreError);

  return { incomplete, keptModelIds };
};

/**
 * The App Blocks DOCUMENT STORE half of an account wipe (`DocStoreMaintenance.wipeAccount`):
 * private documents, authored shared documents and marks deleted, usage released, in
 * every app. Same posture as the per-user storage purge above, for the same reasons: it runs
 * LAST, in a separate database with no transaction spanning the two, and NEVER throws into the
 * wipe: a failure is logged and returned for `incomplete`.
 *
 * RETRY: nothing retries it automatically. A wiped account leaves no state in the main database
 * that a sweep could find it by (the user row stays, with no flag), so the review-storage sweep's
 * pattern does not transfer. The wipe is idempotent, so the retry is re-running the content wipe
 * (`user.removeAllContent`, or the webhook) for that user: every step of it, this one included,
 * only removes what is still there. A namespace that failed rolled back in full.
 */
async function wipeAccountFromDocStore(userId: number): Promise<string | null> {
  try {
    const { getDocStoreMaintenance } = await import(
      '~/server/services/apps/doc-store-maintenance.instance'
    );
    const result = await getDocStoreMaintenance().wipeAccount(userId);
    if (result.failures.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[removeAllContent] App Blocks document store wipe INCOMPLETE (userId=${userId}): ` +
          `${result.failures.length} namespace(s) failed and were left unchanged, ` +
          `${result.namespaces.length} wiped. The content wipe COMPLETED and is unaffected — ` +
          `re-run user.removeAllContent for this user to retry. Failures: ` +
          result.failures.map((f) => `${f.appId}/${f.ns}: ${f.error}`).join('; ')
      );
      return `${result.failures.length} namespace(s) failed`;
    }
    return null;
  } catch (err) {
    const { isDocStoreError } = await import('~/server/services/apps/doc-store.types');
    // No store connection, or one the store refuses: nothing can be removed through it. Not
    // logged, because that is every wipe in an environment without the store. Rows CAN survive
    // here if the store was configured, written to, and then disabled or pointed at a role it
    // refuses (logged once, by the store instance); re-running the wipe once the store is back
    // removes them.
    if (isDocStoreError(err, 'storage_disabled')) return null;
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(
      `[removeAllContent] App Blocks document store wipe failed (userId=${userId}); ` +
        `the content wipe COMPLETED and is unaffected — re-run user.removeAllContent for this ` +
        `user to retry: ${message}`
    );
    return message;
  }
}

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
          equippedAt: true,
          equippedToId: true,
          equippedToType: true,
          forId: true,
          forType: true,
          claimKey: true,
          data: true,
          cosmetic: {
            // Spread rather than hand-listed, so a field added to the shared
            // selector reaches this read too — it is the one the whole cosmetics
            // UI runs on, and a divergence here surfaces as one surface missing a
            // field nobody thinks to check.
            //
            // `createdById` is extra: a scalar on the row already being selected,
            // so no join and no extra round trip, and it is what lets the sticker
            // tray filter to your own without asking a second procedure.
            select: { ...simpleCosmeticSelect, createdById: true, flags: true },
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
  await userBasicCache.refresh(userId);
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
  await userCosmeticCache.refresh(userId);
  // The creator card carries the worn cosmetics too.
  await bustUserCreatorCache(userId);
}

export async function getProfilePicturesForUsers(userIds: number[]) {
  return await profilePictureCache.fetch(userIds);
}

export type CachedUserCosmeticsAndProfilePicture = Pick<
  UserWithCosmetics,
  'profilePicture' | 'cosmetics'
>;

/**
 * The `profilePicture` and `cosmetics` that `userWithCosmeticsSelect` nests, in that shape, from the
 * user caches — one batch per cache for every id. Returns a lookup; a user with neither gets
 * `{ profilePicture: null, cosmetics: [] }`, as the nested select gives.
 */
export async function getCosmeticsAndProfilePicturesForUsers(
  userIds: number[]
): Promise<(userId: number) => CachedUserCosmeticsAndProfilePicture> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return () => ({ profilePicture: null, cosmetics: [] });

  const [profilePictures, cosmetics] = await Promise.all([
    getProfilePicturesForUsers(ids),
    getCosmeticsForUsers(ids),
  ]);

  return (userId) => ({
    profilePicture: profilePictures[userId] ?? null,
    cosmetics: (cosmetics[userId] ?? []).flatMap(({ data, cosmetic }) =>
      cosmetic
        ? [
            {
              data,
              cosmetic: {
                id: cosmetic.id,
                data: cosmetic.data,
                type: cosmetic.type,
                source: cosmetic.source,
                name: cosmetic.name,
              },
            },
          ]
        : []
    ),
  });
}

export async function deleteUserProfilePictureCache(userId: number) {
  await profilePictureCache.refresh(userId);
}

/** The users whose profile picture is one of `imageIds`, from the primary. */
export async function getProfilePictureUserIds(imageIds: number[]) {
  if (!imageIds.length) return [];
  const users = await dbWrite.user.findMany({
    where: { profilePictureId: { in: imageIds } },
    select: { id: true },
  });
  return users.map((x) => x.id);
}

function logProfilePictureRefreshError(error: unknown, meta: Record<string, unknown>) {
  logToAxiom({
    type: 'error',
    name: 'profile-picture-cache-refresh',
    message: (error as Error)?.message,
    ...meta,
  }).catch(() => undefined);
}

/**
 * Re-reads these users' cached profile pictures after a write changed or removed one. Never throws:
 * the write it follows has committed, and a moderation action must not fail on a cache refill.
 */
export async function refreshProfilePicturesForUsers(userIds: number[]) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  try {
    await profilePictureCache.refresh(ids);
  } catch (error) {
    logProfilePictureRefreshError(error, { userIds: ids.join(',') });
  }
}

/**
 * For a write that changed images' rating or ingestion: refreshes the cached profile picture of
 * every user whose picture is one of them, so the avatar gate applies the new rating now rather
 * than at the cache TTL. Never throws, for the same reason as `refreshProfilePicturesForUsers`.
 */
export async function refreshProfilePicturesForImages(imageIds: number[]) {
  let userIds: number[];
  try {
    userIds = await getProfilePictureUserIds(imageIds);
  } catch (error) {
    logProfilePictureRefreshError(error, { imageIds: imageIds.join(',') });
    return;
  }
  await refreshProfilePicturesForUsers(userIds);
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

const leaderboardRankInsert = ({
  leaderboardFilter,
  userFilter,
  onConflict = Prisma.empty,
}: {
  leaderboardFilter: Prisma.Sql;
  userFilter: Prisma.Sql;
  onConflict?: Prisma.Sql;
}) => Prisma.sql`
  WITH user_positions AS (
    SELECT
      lr."userId",
      lr."leaderboardId",
      l."title",
      lr.position,
      -- The showcase is a PREFERENCE, not a filter. Applied as a WHERE clause it
      -- deleted the badge outright whenever the showcased board couldn't produce
      -- one — a RED-exclusive or non-public board, or one the user has since
      -- dropped out of the top 100 on. Measured on prod 2026-08-14: 62 users had
      -- a top-100 placement on an eligible board and no UserRank row at all.
      row_number() OVER (
        PARTITION BY lr."userId"
        ORDER BY
          (lr."leaderboardId" IS NOT DISTINCT FROM u."leaderboardShowcase") DESC,
          lr."position"
      ) row_num
    FROM "User" u
    JOIN "LeaderboardResult" lr ON lr."userId" = u.id
    JOIN "Leaderboard" l ON l.id = lr."leaderboardId" AND l.public
    WHERE lr.date = current_date
      AND lr.position <= 100
      ${leaderboardFilter}
      ${userFilter}
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
  FROM lowest_position
  ${onConflict};
`;

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
    dbWrite.$executeRaw(leaderboardRankInsert({ leaderboardFilter, userFilter: Prisma.empty })),
  ]);
};

/**
 * Per-user variant, for when a user changes their showcase and expects to see it.
 * `updateLeaderboardRank` cannot serve that: it TRUNCATEs a table the whole site
 * reads, so calling it on a profile save blanks every user's badge mid-rebuild.
 * Measured on the prod replica 2026-08-14: 0.87 ms scoped vs 196 ms full.
 *
 * Upsert-only, deliberately. Deleting first would strip a badge and then have nothing
 * to replace it with on any day the 23:00 population failed — the exact symptom this
 * path exists to fix, re-entered through a new door. `prepare-leaderboard` guards the
 * nightly rebuild with `isLeaderboardPopulated` for that reason, and removal stays that
 * job's business: under the ordering above a user with any eligible placement always
 * produces a row, so a save never needs to remove one. It also keeps two concurrent
 * saves off a delete-then-insert race into the `UserRank` primary key.
 */
export const updateLeaderboardRankForUsers = async ({
  userIds,
}: {
  userIds: number | number[];
}) => {
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  if (!ids.length) return;

  await dbWrite.$executeRaw(
    leaderboardRankInsert({
      leaderboardFilter: Prisma.empty,
      userFilter: Prisma.sql`AND u.id IN (${Prisma.join(ids)})`,
      onConflict: Prisma.sql`
    ON CONFLICT ("userId") DO UPDATE SET
      "leaderboardRank" = EXCLUDED."leaderboardRank",
      "leaderboardId" = EXCLUDED."leaderboardId",
      "leaderboardTitle" = EXCLUDED."leaderboardTitle",
      "leaderboardCosmetic" = EXCLUDED."leaderboardCosmetic"`,
    })
  );
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
          meta = ${asJsonbObjectSql('meta')} || ${unpublishedMeta}::jsonb,
          -- Raw SQL skips @updatedAt; the creator score re-scores owners from it.
          "updatedAt" = now()
        WHERE id IN (${Prisma.join(modelIds)})
      `;

      // Update all model versions to Unpublished status
      if (versionIds.length > 0) {
        await tx.$executeRaw`
          UPDATE "ModelVersion"
          SET
            status = ${ModelStatus.Unpublished}::"ModelStatus",
            meta = ${asJsonbObjectSql('meta')} || ${unpublishedMeta}::jsonb
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
  await userModelCountCache.refresh(odRef);

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

export class AlreadyBannedError extends Error {
  constructor(id: number) {
    super(`User ${id} is already banned`);
  }
}

export const toggleBan = async ({
  id,
  reasonCode,
  detailsInternal,
  detailsExternal,
  userId,
  isModerator,
  force,
  removeMedia,
  removeModels,
  removeComments,
  mediaBlockedByCaller,
  keepProfileLinks,
  onlyBan,
  banActivity,
}: ToggleBanUser & {
  userId: number;
  isModerator?: boolean;
  force?: boolean;
  /** Server-only, never in the input schema: the caller blocks the media itself, more strictly. */
  mediaBlockedByCaller?: boolean;
  /** Server-only: a ban an unban may need to undo leaves the profile links, which no unban restores. */
  keepProfileLinks?: boolean;
  /**
   * Server-only: never lifts a ban. Reads the primary, because a replica that has not yet seen a
   * moderator's ban or unban would otherwise decide the direction, and throws on an account that is
   * already banned rather than unbanning it, or replacing a ban that lands before the write.
   */
  onlyBan?: boolean;
  /** Server-only, with `onlyBan`: a `user` ModActivity written in the same transaction as the ban. */
  banActivity?: string;
}) => {
  // Get user with username for search index deletion
  const select = { bannedAt: true, meta: true, username: true, email: true } as const;
  const user = onlyBan
    ? await dbWrite.user.findUnique({ where: { id }, select })
    : await getUserById({ id, select });
  if (!user) throw throwNotFoundError(`No user with id ${id}`);
  if (onlyBan && user.bannedAt) throw new AlreadyBannedError(id);

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

  const data = { bannedAt: bannedAt ? null : new Date(), meta: updatedMeta };
  const updatedUser = onlyBan
    ? await dbWrite.$transaction(async (tx) => {
        const { count } = await tx.user.updateMany({ where: { id, bannedAt: null }, data });
        if (!count) throw new AlreadyBannedError(id);
        if (banActivity) {
          await tx.modActivity.create({
            data: { userId, entityType: 'user', entityId: id, activity: banActivity },
          });
        }
        return tx.user.findUniqueOrThrow({ where: { id } });
      })
    : await updateUserById({ id, data, updateSource: 'toggleBan' });
  void syncOwnerEventHats(id);
  void syncEventRosterMember(id);

  // The ban has committed: a throw here would skip every step below and fail an action that took.
  await invalidateSession(id, 'ban').catch((error) =>
    logToAxiom({
      type: 'error',
      name: 'ban-user-invalidate-session',
      userId: id,
      message: (error as Error).message,
      error,
    })
  );

  if (!bannedAt) {
    // Run cleanup operations in parallel groups
    // Group A: DB-heavy operations (run together)
    // Group B: External API operations (run together)
    // Unpublishing models defaults ON for every ban (historical behavior); a
    // moderator can opt out per-ban. Only `removeModels === false` skips it.
    const shouldRemoveModels = removeModels !== false;

    await Promise.all([
      // Group A: Bulk unpublish models and handle bids
      shouldRemoveModels
        ? bulkUnpublishModelsForBannedUser({ odRef: id, odRefuserId: userId }).catch((error) => {
            logToAxiom({
              type: 'error',
              name: 'ban-user-bulk-unpublish',
              message: error.message,
              error,
            });
          })
        : Promise.resolve(),

      // Wipe public-profile UserLink rows so banned users' off-site links
      // disappear immediately (replaces a manual Retool DELETE step).
      keepProfileLinks
        ? Promise.resolve()
        : dbWrite.userLink.deleteMany({ where: { userId: id } }).catch((error) =>
            logToAxiom({
              type: 'error',
              name: 'ban-user-delete-user-links',
              message: (error as Error).message,
            })
          ),

      // Revoke every live App Block instance of every block this user PUBLISHES.
      // `invalidateSession` above ends their own browser sessions; it does not touch
      // a block token, which is a separate RS256 JWT the runtime guards check against
      // a per-instance Redis marker. Without this the tokens their blocks already hold
      // keep authenticating against the REST and tRPC bridges until natural `exp` —
      // 900s by default, 14400s for a `dev` token. See the writer's own docblock for
      // what is and is not in that set (owner only, not seated collaborators).
      //
      // Isolated like every other leg of this fan-out: the marker write must never be
      // able to fail the ban. `revokeInstance` already swallows Redis errors; this
      // catch covers the DB read in front of it.
      revokeBlockInstancesForPublisher({ userId: id })
        .then((revoked) =>
          logToAxiom({
            type: 'info',
            name: 'ban-user-revoke-block-instances',
            message: `revoked ${revoked} block instance(s) for banned publisher ${id}`,
          })
        )
        .catch((error) =>
          logToAxiom({
            type: 'error',
            name: 'ban-user-revoke-block-instances',
            message: (error as Error).message,
            error,
          })
        ),

      // Group B: External operations (subscription + search indexes)
      Promise.all([
        // Stop the recurring membership from auto-renewing while banned. Cancel
        // at period end so the charge stops but the action is reversible if the
        // ban is later lifted (see reinstate in the unban branch below).
        cancelSubscription({ userId: id, atPeriodEnd: true }).catch((error) =>
          logToAxiom({ name: 'cancel-stripe-subscription', type: 'error', message: error.message })
        ),

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

    // Opt-in "remove all images & videos": block (not delete) the banned user's
    // media. Minor-safety bans always remove it, whatever `removeMedia` says.
    // Blocking (Moderated) preserves the 7-day appeal window — the
    // remove-blocked-images job hard-deletes them after that. CSAM semantics
    // stay reserved for the softDeleteUser path.
    const shouldRemoveMedia =
      !mediaBlockedByCaller &&
      (removeMedia === true ||
        (reasonCode !== undefined && banReasonsAlwaysRemovingMedia.includes(reasonCode)));
    if (shouldRemoveMedia) {
      try {
        // The rows this ban is about to block that still carry account-deletion grace
        // breadcrumbs. Read BEFORE the UPDATE: afterwards they are indistinguishable from the
        // rows the grace pass itself blocked, because both end up `ingestion = 'Blocked'` with
        // `blockedFor = 'moderated'`.
        //
        // 🔴 NOT `clearAccountDeletionImageMarkers({ userId: id })`, and do not "simplify" it back
        // to that. Both of `remove-deleted-user-images`'s statements write the breadcrumb only on
        // a row they leave `ingestion = 'Blocked'` — one sets it in the same UPDATE, the other
        // requires it — and the UPDATE below only touches rows that are NOT Blocked. So for every
        // row the grace pass marked, an account-wide clear here strips a breadcrumb off a row
        // this ban provably did not touch. Lift the ban, restore the
        // account, and `countPendingAccountDeletionImageRestores` (which keys on the breadcrumb)
        // reads 0: `restoreUser` never queues the account, `restore-user-images` never runs, and
        // the library stays Blocked with the recorded prior `ingestion` values gone — silent in
        // the row and silent in the `imagesPendingRestore` the moderator is shown.
        //
        // This set is normally EMPTY. It is non-empty only for a row that was breadcrumbed and
        // then un-blocked during the grace period — `handleUnblockImages` sets
        // `ingestion = 'Scanned'` without stripping the breadcrumb — which is exactly the row a
        // later account restore would otherwise un-block back out of this ban.
        // Its own catch: this read is new, and the media block is the part of a ban that must not
        // be able to fail because of it. Falling back to an empty set degrades the clear to what
        // shipped before the breadcrumbs existed, which is the recoverable direction; letting it
        // escape into the outer catch would skip the block and leave a banned account's media up.
        let graceMarked: { id: number }[] = [];
        try {
          graceMarked = await dbWrite.$queryRaw<{ id: number }[]>`
            SELECT id FROM "Image"
            WHERE "userId" = ${id}
              AND ingestion <> 'Blocked'::"ImageIngestionStatus"
              AND ("metadata" -> ${PRIOR_INGESTION_KEY}::text) IS NOT NULL
          `;
        } catch (error) {
          logToAxiom({
            type: 'error',
            name: 'ban-user-grace-marker-scan',
            message: (error as Error).message,
            error,
          });
        }

        await dbWrite.image.updateMany({
          where: { userId: id, ingestion: { not: 'Blocked' } },
          data: {
            ingestion: 'Blocked',
            nsfwLevel: NsfwLevel.Blocked,
            blockedFor: BlockedReason.Moderated,
          },
        });

        // Same reasoning as the CSAM block in `softDeleteUser`, but scoped to what this statement
        // actually blocked rather than to the account: a ban outranks a grace block, so the
        // restore breadcrumbs come off the rows it hid.
        await clearAccountDeletionImageMarkers({ ids: graceMarked.map((x) => x.id) });
        await refreshProfilePicturesForUsers([id]);
      } catch (error) {
        logToAxiom({
          type: 'error',
          name: 'ban-user-remove-content',
          message: (error as Error).message,
          error,
        });
      }
    }

    // Flagged, not deleted, and the ToS flag rather than `hidden` — `hidden` is a fold any viewer can
    // reopen. See `bulkSetCommentV2TosViolation`.
    if (removeComments) {
      try {
        await Promise.all([
          dbWrite.comment.updateMany({
            where: { userId: id, tosViolation: false },
            data: { tosViolation: true },
          }),
          dbWrite.commentV2.updateMany({
            where: { userId: id, tosViolation: false },
            data: { tosViolation: true },
          }),
        ]);
      } catch (error) {
        logToAxiom({
          type: 'error',
          name: 'ban-user-remove-comments',
          message: (error as Error).message,
          error,
        });
      }
    }

    // The LAST thing the ban branch does. `bannedAt` is written before any of the fan-out above, so a
    // caller polling it is told the ban landed while the model unpublish, media block, comment
    // flagging, index removal and subscription cancels are all still running on the primary — which is
    // how Bulk Ban came to queue a thousand overlapping fan-outs. This is the only signal that means
    // "the expensive half is done", and `banConfirmed` in the moderator app polls it.
    //
    // `jsonb_set` rather than another `updateUserById`: the fan-out takes seconds, and a read-modify-
    // write of `meta` here would clobber anything written to that column in the meantime.
    await dbWrite.$executeRaw`
      UPDATE "User"
      SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{banDetails,completedAt}', to_jsonb(NOW()))
      WHERE id = ${id} AND meta -> 'banDetails' IS NOT NULL
    `;
  } else {
    // Unbanning: reverse the at-period-end cancellation applied on ban, if the
    // membership is still within its paid period.
    await reinstateSubscription({ userId: id }).catch((error) =>
      logToAxiom({ name: 'reinstate-stripe-subscription', type: 'error', message: error.message })
    );

    // 🔴 GIVE THE PUBLISHER'S BLOCKS BACK. Without this a lifted ban left every one of
    // their block instances 403ing for up to MAX_BLOCK_TOKEN_LIFETIME_SECONDS — 4h where a
    // dev token is involved — and re-minting did NOT help: `isRevoked` keys on
    // `claims.blockInstanceId`, and every namespace's id is stable across a re-mint, so a
    // fresh token carries the same id the marker names. The only remedy was a moderator
    // deleting Redis keys by hand. (This card's own AC-3 asserted the opposite; it was
    // wrong, and `blocks/publisher-ban-revocation.service.ts` carries the measurement.)
    //
    // Clears the BAN keyspace only — an INSTALL marker from a genuine uninstall or
    // toggle-off is a different key and survives, so lifting a ban cannot silently
    // re-enable an install its own consumer switched off.
    //
    // Isolated for the same reason as the search re-index below: the unban has already
    // committed, and an unguarded throw here would skip the `account-unbanned` email and
    // hand the moderator a 500 for an action that succeeded.
    await clearBlockInstancesForPublisher({ userId: id })
      .then((cleared) =>
        logToAxiom({
          type: 'info',
          name: 'unban-user-clear-block-instances',
          message: `cleared ${cleared} block-instance ban marker(s) for unbanned publisher ${id}`,
        })
      )
      .catch((error) =>
        logToAxiom({
          type: 'error',
          name: 'unban-user-clear-block-instances',
          message: (error as Error).message,
          error,
        })
      );

    // 🔴 Put the account BACK in user search. Ban removes the document, and nothing else ever
    // re-adds it: the incremental sync's range scan keys on `createdAt`, so an existing row is
    // never re-pulled, and the reconciler only deletes. Without this, a lifted ban leaves the
    // account permanently unfindable — a one-way door.
    // Isolated for the same reason as the rename path: the unban has already committed, and an
    // unguarded throw here would skip the `account-unbanned` email below and hand the moderator
    // a 500 for an action that succeeded.
    await usersSearchIndex
      .queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }])
      .catch((error) =>
        logToAxiom({
          type: 'error',
          name: 'unban-user-search-index',
          message: (error as Error).message,
        })
      );
  }

  // Notify the user by email of the ban/unban decision. Skip the admin
  // force-clear/re-ban path (`force`) since that isn't a user-facing decision.
  // Never let an email failure break the ban: isolate in try/catch -> Axiom.
  if (!force && user.email) {
    try {
      if (!bannedAt) {
        // Being banned: the email shows only the sanitized public ban-reason
        // label (never the private label, and never the moderator's free-text
        // `detailsExternal`). Free text is kept in `meta.banDetails` for the
        // appeal/Retool flow but is never emailed — this avoids exposing
        // explicit/targeted prose to the user. The TOS link in the email
        // template provides the policy reference.
        const publicLabel = reasonCode
          ? banReasonDetails[reasonCode]?.publicBanReasonLabel
          : undefined;
        const reason = publicLabel && publicLabel.trim().length > 0 ? publicLabel : undefined;

        await moderationActionEmail.send({
          to: user.email,
          username: user.username ?? 'User',
          kind: 'account-banned',
          reason,
        });
      } else {
        // Being unbanned: ban details are wiped on unban, so send no reason.
        await moderationActionEmail.send({
          to: user.email,
          username: user.username ?? 'User',
          kind: 'account-unbanned',
        });
      }
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: 'ban-email-failed',
        message: (error as Error).message,
        error,
      });
    }
  }

  return updatedUser;
};

export const getBanContentPreview = async ({ userId }: { userId: number }) => {
  const [imageCount, modelCount] = await Promise.all([
    dbRead.image.count({
      where: { userId, ingestion: { not: 'Blocked' } },
    }),
    dbRead.model.count({
      where: {
        userId,
        status: { in: [ModelStatus.Published, ModelStatus.Scheduled] },
      },
    }),
  ]);
  return { imageCount, modelCount };
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

  await refreshSession(id, { caller: 'ban' });

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
    await dbWrite.articleEngagement.create({ data: { userId, articleId, type } }).catch((error) => {
      // Toggle racing itself → P2002 on the articleEngagement PK. NOTE the PK is
      // (userId, articleId) — it does NOT include `type` — so the dominant case
      // (same-type double-click) is cleanly idempotent, but a concurrent
      // DIFFERENT-type write (Favorite vs Hide) on the same article can also
      // trip this. Either way the row exists and the client re-reads engagement
      // state, so swallowing P2002 is strictly better than a 500.
      if (!isPrismaUniqueViolation(error)) throw error;
    });
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

// TODO(model3d-workstream-E): wire CollectionType.Model3D through bookmark + metrics flow
//   once model3dMetrics exists. For now Model3D bookmarks short-circuit before reaching
//   these maps (see toggleBookmarked below).
const collectionEntityProps: Partial<Record<CollectionType, string>> = {
  [CollectionType.Article]: 'articleId',
  [CollectionType.Model]: 'modelId',
  [CollectionType.Image]: 'imageId',
  [CollectionType.Post]: 'postId',
};
// Image intentionally absent: its metrics are ClickHouse-owned (the legacy PG
// ImageMetric processor was retired), so image bookmarks skip the PG queueUpdate.
// A function, not a module-level map: ~/server/metrics reaches this file again through the
// image.service import cycle, so at load time it can still be half-initialised. A process that
// imports image.service or post.service first crashed here.
const collectionEntityMetrics = (type: CollectionType): typeof articleMetrics | undefined =>
  ((
    {
      [CollectionType.Article]: articleMetrics,
      // Model collectedCount is its own job; modelMetrics' queue never reached it.
      [CollectionType.Model]: modelCollectionMetrics,
      [CollectionType.Post]: postMetrics,
    } as Partial<Record<CollectionType, typeof articleMetrics>>
  )[type]);
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
    // Race #1: the bookmark collection is guarded by a prod-only partial unique index
    // `User_bookmark_collection UNIQUE (userId, type, mode) WHERE mode='Bookmark'` (NOT in the
    // Prisma schema). Two concurrent toggles can both see null and both create → loser hits P2002.
    // Prisma `upsert` can't target a partial WHERE index, so create-then-refetch on the conflict.
    collection =
      (await dbWrite.collection
        .create({
          data: {
            userId,
            type,
            mode: CollectionMode.Bookmark,
            name: `Bookmarked ${type}`,
            description: `Your bookmarked ${type.toLowerCase()} will appear in this collection.`,
          },
        })
        .catch((e) => {
          if (!isPrismaUniqueViolation(e)) throw e;
          return null; // lost the create race — fall through to re-fetch
        })) ??
      (await dbWrite.collection.findFirst({
        where: { userId, type, mode: CollectionMode.Bookmark },
      }));
    if (!collection)
      throw new Error('toggleBookmarked: bookmark collection missing after create race');
  }

  const entityProp = collectionEntityProps[type];
  const metricsEngine = collectionEntityMetrics(type);
  if (!entityProp) {
    // TODO(model3d-workstream-E): Model3D bookmarks land here until model3dMetrics ships.
    throw new Error(`toggleBookmarked: no bookmark route for CollectionType.${type}`);
  }
  const collectionItem = await dbWrite.collectionItem.findFirst({
    where: {
      [entityProp]: entityId,
      collectionId: collection.id,
    },
  });

  const exists = collectionItem;

  // if the engagement exists, we only need to remove the existing engagmement
  if (exists && setTo !== true) {
    // Race #3: concurrent un-bookmarks both read the same row then both delete it → loser hits
    // P2025 ("record not found"). `deleteMany` returns {count} and never throws on zero rows, so
    // it's fully idempotent — no try/catch needed.
    await dbWrite.collectionItem.deleteMany({
      where: {
        id: collectionItem.id,
      },
    });
    metricsEngine?.queueUpdate(entityId);
  } else if (!exists && setTo !== false) {
    // Race #2: the collection item is guarded by prod-only partial unique indexes
    // (`CollectionItem_model UNIQUE (collectionId, modelId) WHERE modelId IS NOT NULL`, and the
    // analogous image/post/article indexes — NOT in the Prisma schema). Concurrent bookmarks both
    // see no row and both create → loser hits P2002. `createMany({ skipDuplicates: true })` emits
    // ON CONFLICT DO NOTHING, so the race resolves at the DB with no throw. The return value isn't
    // used (the function returns `!exists`).
    await dbWrite.collectionItem.createMany({
      // addedById is what the CDC handler attributes the collectedCount event to; without it the
      // event is dropped and the bookmark never counts.
      data: [{ collectionId: collection.id, [entityProp]: entityId, addedById: userId }],
      skipDuplicates: true,
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
    select: { id: true, recommended: true, modelVersionId: true },
  });
  setTo ??= review ? false : true;

  if (setTo === false) {
    await dbWrite.resourceReview.deleteMany({ where: { modelId, modelVersionId, userId } });
    modelMetrics.queueUpdate(modelId);
    // Use the actual modelVersionId from the existing review row when input was
    // undefined. If the user had reviews on multiple versions (rare — typically
    // 1 review per user per model), only the first row's version tag gets busted
    // and the rest fall back to the 1h TTL.
    await bustRatingTotalsCache({
      modelId,
      modelVersionId: modelVersionId ?? review?.modelVersionId,
    }).catch(() => undefined);
  } else {
    if (review) {
      if (setTo !== review.recommended) {
        await dbWrite.resourceReview.update({
          where: { id: review.id },
          data: { recommended: setTo },
        });
        await bustRatingTotalsCache({
          modelId,
          modelVersionId: review.modelVersionId,
        }).catch(() => undefined);
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
      await bustRatingTotalsCache({ modelId, modelVersionId }).catch(() => undefined);
    }
  }

  await preventReplicationLag('resourceReview', userId);
  void onModelReviewsChanged([{ modelId, userId }]);

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
    await dbWrite.bountyEngagement.create({ data: { userId, bountyId, type } }).catch((error) => {
      // Toggle racing itself → P2002 on the (type, bountyId, userId) PK. The
      // engagement already exists — idempotent, so return true (toggled on)
      // instead of bubbling a 500.
      if (!isPrismaUniqueViolation(error)) throw error;
    });
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
  const findArgs = {
    where: { id },
    select: { id: true, referral: { select: { id: true, userReferralCodeId: true } } },
  } as const;
  const user = await dbRead.user.findUniqueOrThrow(findArgs).catch(() => {
    dbReadFallbackCounter.inc({ entity: 'user', caller: 'createUserReferral' });
    return dbWrite.user.findUniqueOrThrow(findArgs);
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
    // Confirm userReferralCode is valid. Use the primary so a referral code
    // that was generated moments ago (e.g. fresh signup landing on a friend's
    // profile) isn't missed by replica lag.
    const referralCode = !!userReferralCode
      ? await dbWrite.userReferralCode.findFirst({
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
      // Create new referral. Two parallel calls (e.g. an onboarding submit
      // racing with a redirect retry) could both pass the existing-check
      // above and trip the unique(userId) constraint here. Catch the
      // collision and treat it as success — the row is in place either way.
      let createdReferral = true;
      try {
        await dbWrite.userReferral.create({
          data: {
            userId: id,
            source,
            landingPage,
            loginRedirectReason,
            userReferralCodeId: referralCode?.id ?? undefined,
          },
        });
      } catch (err) {
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code?: string }).code === 'P2002'
        ) {
          createdReferral = false;
        } else {
          throw err;
        }
      }

      if (createdReferral && referralCode?.id) {
        await applyRewards({
          refereeId: id,
          referrerId: referralCode.userId,
        }).catch(handleLogError);
      }
    }
  }
};

const cosmeticGrantSelect = {
  id: true,
  availableStart: true,
  availableEnd: true,
  source: true,
} satisfies Prisma.CosmeticSelect;

export const claimCosmetic = async ({ id, userId }: { id: number; userId: number }) => {
  const cosmetic = await dbRead.cosmetic.findUnique({
    where: { id, source: CosmeticSource.Claim },
    select: cosmeticGrantSelect,
  });
  if (!cosmetic) return null;
  if (!(await isCosmeticAvailable(cosmetic.id, userId))) return null;

  await grantCosmetic({ cosmeticId: cosmetic.id, userId });
  return cosmetic;
};

// Server-side award paths only; never expose through a router.
export const awardTrophyCosmetic = async ({ id, userId }: { id: number; userId: number }) => {
  const cosmetic = await dbRead.cosmetic.findUnique({
    where: { id, source: CosmeticSource.Trophy },
    select: cosmeticGrantSelect,
  });
  if (!cosmetic) return null;

  await grantCosmetic({ cosmeticId: cosmetic.id, userId });
  return cosmetic;
};

async function grantCosmetic({ cosmeticId, userId }: { cosmeticId: number; userId: number }) {
  const userCosmetic = await dbRead.userCosmetic.findFirst({
    where: { userId, cosmeticId },
  });
  if (userCosmetic) throw throwConflictError('You already have this cosmetic');

  await dbWrite.userCosmetic.create({
    data: { userId, cosmeticId },
  });
  await refreshOwnedStickerCache([userId]);

  await usersSearchIndex.queueUpdate([{ id: userId, action: SearchIndexUpdateQueueAction.Update }]);
}

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
    select: { obtainedAt: true, cosmetic: { select: { type: true, data: true } } },
  });
  if (!userCosmetics.length) throw new Error("You don't have that cosmetic");
  // An event decoration is placed on content, never worn by the user: equipped here it would show
  // on every user-level read, none of which applies the event's preview gate.
  if (userCosmetics.some((x) => isEventDecorationData(x.cosmetic.data)))
    throw new Error('Event decorations are placed on content, not equipped');

  const types = [...new Set(userCosmetics.map((x) => x.cosmetic.type))];
  // Stickers are owned, not equipped — everything you own is already in the
  // picker, so equipping has nothing to mean. Guarded here and not only in the
  // UI so an equipped sticker can't exist for the buckets to have to explain.
  if (types.includes(CosmeticType.Sticker)) throw new Error('Stickers cannot be equipped');
  if ((await getWithheldCosmeticIds(cosmeticId, dbWrite)).size)
    throw throwBadRequestError(WITHHELD_COSMETIC_ERROR);

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
  await refuseIfWithheldAfterEquip(cosmeticId);

  // Clear cache
  await deleteUserCosmeticCache(userId);
  await queueWornCosmeticsUpdate([userId]);
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
  await queueWornCosmeticsUpdate([userId]);
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
  confirmOnPrimary = false,
}: {
  userId: number;
  targetUserId?: number;
  /**
   * Write gates (comment and reaction via throwIfBlockedByOwners, tip, challenge entry, and
   * the prompt-provenance mint) pass true: when the cache says "not blocked", confirm
   * against the primary. A cache entry can miss a block that just
   * landed (see the comment below), and a write path must not let a blocked user
   * through for that window. Page views leave it off and stay cache-only.
   */
  confirmOnPrimary?: boolean;
}) {
  if (!targetUserId) return false;
  if (targetUserId === userId) return false;

  // For page views the cache is the answer. `BlockedByUsers` is invalidated for the blocked
  // user by the only writer that creates a Block (`toggleBlockUser`), refills from the
  // primary, and its hash carries a TTL as a backstop. There used to be a per-request
  // `userEngagement` lookup here on every cache miss; it ran on every logged-in detail view
  // and only caught a missed invalidation, which on a page view now persists until the
  // hash TTL instead. The remaining window: a refill that read before the block committed
  // and wrote after the invalidation.
  const cachedBlockedBy = await BlockedByUsers.getCached({ userId });
  if (cachedBlockedBy.some((user) => user.id === targetUserId)) return true;
  if (!confirmOnPrimary) return false;

  const engagement = await dbWrite.userEngagement.findFirst({
    where: { userId: targetUserId, targetUserId: userId, type: 'Block' },
    select: { userId: true },
  });
  return !!engagement;
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
  ...data
}: UpdateContentSettingsInput & { userId: number }) {
  try {
    // Settings first: if the column write below then fails, the level did not change and the
    // only loss is the retired red copy. The other order could commit a new level while
    // leaving that copy for the one-off fold to apply over it.
    if (Object.keys(data).length > 0 || browsingLevel !== undefined) {
      // Only the keys this call is changing. Re-reading the blob and writing it back
      // would restore every other key to the value it held at read time, discarding a
      // concurrent write to any of them (notice dismissals, feature toggles, …).
      await patchUserSettings(userId, {
        set: removeEmpty(data),
        // A level set now supersedes any retired red-domain copy, so the one-off fold of those
        // copies into the column never applies a stale value over it.
        ...(browsingLevel !== undefined ? { remove: ['redBrowsingLevel'] } : {}),
        location: 'user.service:updateContentSettings',
      });
    }
    if (
      blurNsfw !== undefined ||
      showNsfw !== undefined ||
      browsingLevel !== undefined ||
      autoplayGifs !== undefined
    ) {
      await dbWrite.user.update({
        where: { id: userId },
        data: { blurNsfw, showNsfw, browsingLevel, autoplayGifs },
      });
      userUpdateCounter?.inc({ location: 'user.service:updateUserContentSettings' });
      await userSettingsCache().bust([userId]);
    }
  } finally {
    // Also when a later write throws: an earlier one may already have committed, and the
    // cached session must not keep serving the old value for its whole lifetime.
    //
    // Await so the refresh marker is set in Redis before this mutation returns.
    // Otherwise the fire-and-forget can race the next API call / session read
    // and hand back a stale session.user, which then overrides the user's
    // toggle client-side via BrowserSettingsProvider's smart-merge.
    await refreshSession(userId, { caller: 'profile' }).catch((err) => {
      console.error('Failed to refresh session for user', userId, err);
    });
  }
}

// #region [user settings]
// User-level content preference columns that we cache alongside the settings
// JSON so the client can patch them in one place (see getUserContentSettings).
// Public type `UserContentSettings` lives in `~/server/schema/user.schema` so
// client code can import it without dragging the service module into the
// browser bundle.
type CachedUserSettings = UserSettingsSchema & {
  userId: number;
  showNsfw: boolean;
  blurNsfw: boolean;
  autoplayGifs: boolean | null;
};

/** A stored `settings` value that is a JSON object (not null, not an array, not a scalar). */
function isPlainSettingsObject(value: unknown): value is UserSettingsSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Built on first USE, not on import. A module-scope createCachedObject() runs during module
// evaluation, so any suite that wholesale-mocks `~/server/utils/cache-helpers` or
// `~/server/redis/client` and merely reaches this service transitively fails at COLLECTION —
// before a single test runs, with nothing in the failing suite naming this file.
function createUserSettingsCache() {
  return createCachedObject<CachedUserSettings>({
    key: REDIS_KEYS.USER.SETTINGS,
    idKey: 'userId',
    ttl: CacheTTL.hour * 4,
    staleWhileRevalidate: false,
    // The bust window keeps a replica read from being re-cached; this lookup reads the primary, so
    // a longer window would only add uncached primary reads. 1 is the minimum (it is the marker's EX).
    debounceTime: 1,
    lookupFn: async (ids) => {
      const rows = await dbWrite.$queryRaw<
        {
          id: number;
          settings: UserSettingsSchema | null;
          showNsfw: boolean;
          blurNsfw: boolean;
          autoplayGifs: boolean | null;
        }[]
      >`
    SELECT id, settings, "showNsfw", "blurNsfw", "autoplayGifs"
    FROM "User"
    WHERE id IN (${Prisma.join(ids)})
  `;
      return Object.fromEntries(
        rows.map((x) => [
          x.id,
          {
            userId: x.id,
            // Spread only a plain object. Nothing enforces a shape on the JSON column, and
            // spreading an array yields `"0"`, `"1"`, … keys — fed back into a write, that
            // nests each copy of the blob inside the next.
            ...(isPlainSettingsObject(x.settings) ? x.settings : {}),
            showNsfw: x.showNsfw,
            blurNsfw: x.blurNsfw,
            autoplayGifs: x.autoplayGifs,
          },
        ])
      );
    },
  });
}

let userSettingsCacheInstance: ReturnType<typeof createUserSettingsCache> | undefined;
function userSettingsCache() {
  return (userSettingsCacheInstance ??= createUserSettingsCache());
}

/**
 * JSON-settings-only view, without the User-column fields.
 *
 * 🔴 Redis-backed (4h TTL) and READ-ONLY as far as writers are concerned. No caller may
 * read this and write the result back — that read-modify-write is the lost-update bug
 * `patchUserSettings` exists to remove, and the cache makes its window the TTL rather
 * than a few milliseconds. Read it to DECIDE something (a toggle's next value, whether a
 * value changed); never to build a write payload. Do not call it inside a transaction
 * either: it is a Redis round trip on the transaction's clock.
 */
export async function getUserSettings(id: number): Promise<UserSettingsSchema> {
  const result = await userSettingsCache().fetch([id]);
  const raw = result[id];
  if (!raw) return {};
  const { userId, showNsfw, blurNsfw, autoplayGifs, ...settings } = raw;
  return settings;
}

/**
 * Full content settings view (JSON settings + User-column preferences).
 * Use this for the tRPC `user.getSettings` endpoint / SSR hydration so the
 * client can patch all toggles in a single React Query cache.
 */
export async function getUserContentSettings(id: number): Promise<UserContentSettings> {
  const result = await userSettingsCache().fetch([id]);
  const raw = result[id];
  if (!raw) return {};
  const { userId, ...rest } = raw;
  return rest;
}

/**
 * The one place `User.settings` is written.
 *
 * `settings` is a single JSON column with many independent writers (content
 * prefs, feature toggles, tour progress, notice dismissals, creator shop,
 * gallery defaults). Every one of them used to read the blob into JS, compute a
 * new object, and write that object back. Two such writers overlapping lose one
 * of the two edits: the second writer's snapshot was taken before the first
 * writer's commit, so writing it back restores the pre-edit value of every key
 * it happens to carry — including keys it was never asked to change.
 *
 * The cure is structural rather than temporal: never send a value that was read
 * in JS. Each op below compiles to an expression over the *current* column, so
 * the read and the write are one statement and there is no JS-side window at
 * all. Under READ COMMITTED, Postgres re-evaluates a SET expression against the
 * updated row when a concurrent transaction has just written it, so two
 * overlapping patches compose instead of clobbering.
 *
 * Ops (all optional, all applied in one statement, in this order):
 *  - `set`           — replace these top-level keys outright. The patch WINS over
 *                      the stored value; that is the whole point, so the operand
 *                      order of the `||` below is load-bearing rather than stylistic.
 *  - `mergeInto`     — merge one level INTO these top-level object keys, so a
 *                      sibling sub-key another writer added survives.
 *  - `deepMergeInto` — merge one level further: a sub-key of a top-level object is
 *                      itself merged rather than replaced. `mergeInto` alone still
 *                      loses a race between two writers of the SAME sub-key (e.g.
 *                      two `tourSettings.welcome` writes), because it replaces
 *                      `tourSettings.welcome` wholesale; this composes the two
 *                      writers' fields instead. Only `tourSettings` uses this today.
 *  - `remove`        — delete these top-level keys.
 *
 * 🔴 `set` and `mergeInto` do NOT compose on the SAME top-level key, and neither
 * does `deepMergeInto` with either of them. All three read `settings->key` — the
 * STORED column — not the partially-built expression, so combining ops on one key
 * makes the later op win over the earlier op's in-progress result rather than
 * compose with it. No caller does this today; if one ever needs to, make the ops
 * read from the accumulated expression instead of the column.
 *
 * Values are bound as parameters, never spliced into the statement text —
 * `JSON.stringify` escapes `"` and `\` but not `'`, so a setting value holding
 * an apostrophe would otherwise close the literal early.
 *
 * Pass `tx` to run inside a caller's transaction; the caller then owns the
 * cache bust, which must happen after commit (Redis I/O inside a transaction
 * burns the transaction's wall-clock budget).
 */
export type UserSettingsPatch = {
  set?: Record<string, unknown>;
  mergeInto?: Record<string, Record<string, unknown>>;
  /** One level deeper than `mergeInto`: top-level key -> sub-key -> patch. */
  deepMergeInto?: Record<string, Record<string, Record<string, unknown>>>;
  remove?: string[];
  /** `userUpdateCounter` label, so consolidating the writers does not collapse the
   *  per-call-site attribution the metric already carried. */
  location?: string;
};

type RawClient = Pick<typeof dbWrite, '$queryRawUnsafe'>;

/**
 * The stored `settings` column as a jsonb OBJECT: the stored value when it is one, `{}`
 * otherwise. Every writer of `User.settings` starts from this, never from the bare column.
 *
 * 🔴 `COALESCE(settings, '{}')` is NOT this. It replaces only SQL NULL, so a stored JSON
 * `null` or an array passes straight through, and the two operations the writers build on
 * both go wrong on it: `jsonb || jsonb` CONCATENATES instead of merging
 * (`'null' || '{"a":1}'` is `[null, {"a": 1}]`, and every later write appends another
 * element — unbounded growth, with every key permanently unreadable), and `jsonb_set`
 * RAISES (`path element at position 1 is not an integer` on an array, `cannot set path in
 * scalar` on a scalar), so the write fails outright for that user. Treating a non-object as
 * `{}` makes the next write repair the row — the same self-healing property the nested-key
 * guards in `patchUserSettings` restore one level down.
 *
 * The top level and every nested key share one builder, `asJsonbObject`, so a change to
 * the guard cannot reach one level and miss the other.
 */
const SETTINGS_AS_OBJECT = asJsonbObject('settings');

export async function patchUserSettings(
  userId: number,
  patch: UserSettingsPatch,
  tx?: RawClient
): Promise<UserSettingsSchema> {
  const set = patch.set && Object.keys(patch.set).length ? patch.set : undefined;
  const mergeInto = Object.entries(patch.mergeInto ?? {}).filter(
    ([, value]) => value && Object.keys(value).length
  );
  const deepMergeInto = Object.entries(patch.deepMergeInto ?? {})
    .map(
      ([key, subPatch]) =>
        [
          key,
          Object.entries(subPatch ?? {}).filter(([, value]) => value && Object.keys(value).length),
        ] as const
    )
    .filter(([, subEntries]) => subEntries.length);
  const remove = patch.remove?.length ? patch.remove : undefined;

  const client = tx ?? dbWrite;

  // Nothing to write, but the contract is still "the settings this user now has".
  // Read the ROW, never the cache: `getUserSettings` is Redis-backed, and both `tx`
  // callers reach this branch with an empty patch — `updateCreatorShopSettings` when
  // every field of its all-optional input is omitted, and the gallery copy when the
  // model already carries default gallery settings. A Redis round trip there would
  // burn the caller's interactive-transaction budget (Prisma's default is 5s), and
  // the repo's `no-io-in-transaction` lint rule is a call-name denylist that cannot
  // see it. Reading the row also keeps the return value consistent with the write
  // path below, which returns `RETURNING settings` rather than a cached blob.
  if (!set && !mergeInto.length && !deepMergeInto.length && !remove) {
    const current = await client.$queryRawUnsafe<{ settings: UserSettingsSchema | null }[]>(
      `SELECT settings FROM "User" WHERE id = $1`,
      userId
    );
    if (!current.length) throw throwNotFoundError(`No user with id ${userId}`);
    // Same shape rule as the write path, which can only ever RETURN an object.
    const stored: unknown = current[0]?.settings;
    return isPlainSettingsObject(stored) ? stored : {};
  }

  const values: unknown[] = [];
  // Returns the `$N` placeholder for a newly bound value.
  const bind = (value: unknown) => `$${values.push(value)}`;

  // The base is the guarded column, not `COALESCE(settings, …)`: the top level carries the
  // same concatenate-instead-of-merge hazard as the nested keys below (see SETTINGS_AS_OBJECT).
  let expr = SETTINGS_AS_OBJECT;
  if (set) expr = `(${expr} || ${bind(JSON.stringify(set))}::jsonb)`;
  for (const [key, value] of mergeInto) {
    // `settings->$key` reads the CURRENT column inside the same statement — that is
    // what makes the nested merge atomic rather than a read-modify-write.
    //
    // 🔴 The `jsonb_typeof` test is the same guard, and for the same reason, as the one
    // in `setAlertDismissed` below. Nothing enforces a shape on a JSON column, and
    // `jsonb || jsonb` does NOT raise on a non-object — it CONCATENATES, so a stored
    // `{"chat": 7}` merges to `{"chat": [7, {...}]}` and every later write appends
    // another element. That is unbounded growth in the column plus permanently
    // undefined reads for that key, from a value no statement here would reject.
    //
    // The direction matters: a plain `COALESCE` would make this primitive SELF-WORSENING
    // where the whole-key `set` it replaced was self-healing (a rewrite overwrote the bad
    // value). Treating a non-object as absent restores that property — the next write
    // repairs the row. This is hardening, not a live fix: sampled prod rows are 100%
    // objects for every key written this way, but `mergeInto` is now the designated
    // nested-write primitive for `chat`, `features`, `creatorShop` and `gallerySettings`
    // (`tourSettings` uses `deepMergeInto`, below), so the gap would be inherited
    // four times over.
    const k = bind(key);
    expr =
      `(${expr} || jsonb_build_object(${k}::text, ` +
      `${asJsonbObject(`settings->${k}::text`)} ` +
      `|| ${bind(JSON.stringify(value))}::jsonb))`;
  }
  for (const [key, subEntries] of deepMergeInto) {
    // Same guard as `mergeInto`, applied twice: once for the top-level key (so a
    // malformed `tourSettings` doesn't concatenate) and once per sub-key (so a
    // malformed `tourSettings.welcome` doesn't either). Both reads are of the STORED
    // column, same reasoning as the `set`/`mergeInto` non-composition note above.
    const k = bind(key);
    let sub = asJsonbObject(`settings->${k}::text`);
    for (const [subKey, value] of subEntries) {
      const sk = bind(subKey);
      sub =
        `(${sub} || jsonb_build_object(${sk}::text, ` +
        `${asJsonbObject(`settings->${k}::text->${sk}::text`)} ` +
        `|| ${bind(JSON.stringify(value))}::jsonb))`;
    }
    expr = `(${expr} || jsonb_build_object(${k}::text, ${sub}))`;
  }
  // `jsonb - text[]` drops every listed key in one go, so the names bind as one array.
  if (remove) expr = `(${expr} - ${bind(remove)}::text[])`;

  const rows = await client.$queryRawUnsafe<{ settings: UserSettingsSchema | null }[]>(
    `UPDATE "User" SET settings = ${expr} WHERE id = ${bind(userId)} RETURNING settings`,
    ...values
  );
  // A raw UPDATE matching no row is a silent no-op, where the `user.update` this
  // replaced raised Prisma P2025. A moderator acting on a deleted user must not get
  // a success back.
  if (!rows.length) throw throwNotFoundError(`No user with id ${userId}`);
  userUpdateCounter?.inc({ location: patch.location ?? 'user.service:patchUserSettings' });

  if (!tx) await bustUserSettings(userId);
  return rows[0]?.settings ?? {};
}

/** Drop every per-user cache that mirrors the settings blob. */
export async function bustUserSettings(userId: number) {
  await userSettingsCache().bust([userId]);
  // Keep the read-time metric-privacy defaults cache consistent with a settings write
  // (the `hideModel*` flags live in `settings`); TTL backstops any other writer.
  await bustUserMetricPrivacyDefaultsCache(userId);
}

/**
 * Split a caller-supplied settings object into the keys to write and the keys to
 * delete. An explicit `undefined` marks a key for removal — the tRPC transformer
 * carries that over the wire and zod keeps the key, so `user.setSettings` really
 * can ask for one. Single source of this rule: every settings write goes through
 * it, so the two halves cannot drift apart at one call site.
 */
export function splitSettingsPatch(settings: UserSettingsInput): UserSettingsPatch {
  return {
    set: removeEmpty(settings),
    remove: Object.entries(settings)
      .filter(([, value]) => value === undefined)
      .map(([key]) => key),
  };
}

/**
 * Shallow set/remove of top-level settings keys. A key whose value is
 * `undefined` is deleted; everything else is written as given.
 */
export async function setUserSetting(userId: number, settings: UserSettingsInput) {
  return patchUserSettings(userId, {
    ...splitSettingsPatch(settings),
    // Was two statements with two labels (`:set` and `:remove`); it is one statement now,
    // so it reports one.
    location: 'user.service:setUserSetting:set',
  });
}

/**
 * Add or drop one id in `settings.dismissedAlerts`, as a set operation on the
 * stored array rather than a whole-array rewrite. Two dismissals of *different*
 * notices can now overlap without either being lost — which the previous
 * read-the-array-in-JS-and-write-it-back form could not survive.
 */
/**
 * Set `meta.emailVerificationRequired` without reading `meta` into JS first.
 *
 * `User.meta` is shared: `banDetails`, `muteReason`/`mutedBy`, contest-ban state and more live on it,
 * written by moderation paths that know nothing about this one. A read-modify-write would clobber
 * whichever of them landed in the window — and the read would be off the replica, so the window is
 * replica lag rather than milliseconds. `jsonb_set` merges in the database, touching one key.
 */
export async function setEmailVerificationRequired(userId: number, required: boolean) {
  await dbWrite.$executeRaw`
    UPDATE "User"
    SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{emailVerificationRequired}', to_jsonb(${required}::boolean))
    WHERE id = ${userId}
  `;
  userUpdateCounter?.inc({ location: 'user.service:setEmailVerificationRequired' });
}

export async function setAlertDismissed(userId: number, alertId: string, dismissed: boolean) {
  // `settings->'dismissedAlerts'` is read inside the statement, so nothing about the
  // array is carried through JS. Add is idempotent (`@>` containment guard); `jsonb_agg`
  // over an empty set yields NULL, hence the COALESCE to an empty array.
  //
  // `WITH ORDINALITY` + `ORDER BY ord` makes the surviving elements' order explicit rather
  // than incidental. Nothing DEPENDS on that order — `dismissedAlerts` is read as a set
  // (membership tests only) — and no test pins it, so treat this as intent, not a
  // guarantee: dropping the `ORDER BY` is very likely an equivalent mutant.
  //
  // The `jsonb_typeof` test is not paranoia about our own writers — nothing enforces a
  // shape on a JSON column, and `jsonb_array_elements` raises on a non-array, which
  // would turn one malformed row into a permanent 500 on every dismissal for that user.
  // Treating a non-array as empty self-heals it on the next write, which is what the
  // whole-array rewrite used to do implicitly. The same holds one level up: `jsonb_set`
  // raises on a non-object `settings`, hence SETTINGS_AS_OBJECT rather than a COALESCE.
  const current = `CASE WHEN jsonb_typeof(settings->'dismissedAlerts') = 'array'
                        THEN settings->'dismissedAlerts' ELSE '[]'::jsonb END`;
  const next = dismissed
    ? `CASE WHEN ${current} @> to_jsonb($1::text) THEN ${current}
            ELSE ${current} || jsonb_build_array($1::text) END`
    : `COALESCE((
         SELECT jsonb_agg(e ORDER BY ord)
         FROM jsonb_array_elements(${current}) WITH ORDINALITY AS t(e, ord)
         WHERE e <> to_jsonb($1::text)
       ), '[]'::jsonb)`;

  const rows = await dbWrite.$queryRawUnsafe<{ settings: UserSettingsSchema | null }[]>(
    `UPDATE "User"
     SET settings = jsonb_set(${SETTINGS_AS_OBJECT}, '{dismissedAlerts}', ${next})
     WHERE id = $2
     RETURNING settings`,
    alertId,
    userId
  );
  userUpdateCounter?.inc({ location: 'user.service:setAlertDismissed' });
  await bustUserSettings(userId);
  return rows[0]?.settings?.dismissedAlerts ?? [];
}
// #endregion
