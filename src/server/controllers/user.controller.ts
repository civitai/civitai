import { TRPCError } from '@trpc/server';
import { orderBy } from 'lodash-es';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { clickhouse } from '~/server/clickhouse/client';
import { purgeCache } from '~/server/cloudflare/client';
import { constants } from '~/server/common/constants';
import type { NotificationCategory } from '~/server/common/enums';
import {
  OnboardingComplete,
  OnboardingSteps,
  SearchIndexUpdateQueueAction,
} from '~/server/common/enums';
import type { Context, ProtectedContext } from '~/server/createContext';
import { getStaticContent, resolveTosHash } from '~/server/services/content.service';
import { dbRead, dbWrite } from '~/server/db/client';
import { onboardingCompletedCounter, onboardingErrorCounter } from '~/server/prom/client';
import { getUserFollows } from '~/server/redis/caches';
import { redis, REDIS_KEYS, REDIS_SUB_KEYS } from '~/server/redis/client';
import * as rewards from '~/server/rewards';
import { firstDailyFollowReward } from '~/server/rewards/active/firstDailyFollow.reward';
import type { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import type { PaymentMethodDeleteInput } from '~/server/schema/stripe.schema';
import type {
  DeleteUserInput,
  GetAllUsersInput,
  GetEngagedModelsByIdsInput,
  GetBanContentPreviewInput,
  GetByUsernameSchema,
  GetUserByUsernameSchema,
  GetUserCosmeticsSchema,
  GetUserListSchema,
  GetUserTagsSchema,
  ReportProhibitedRequestInput,
  RestoreUserInput,
  SetLeaderboardEligibilitySchema,
  SetUserSettingsInput,
  ToggleBanUser,
  ToggleFavoriteInput,
  ToggleFeatureInput,
  ToggleFollowUserSchema,
  ToggleModelEngagementInput,
  ToggleUserArticleEngagementsInput,
  ToggleUserBountyEngagementsInput,
  UserByReferralCodeSchema,
  UserOnboardingSchema,
  UserUpdateInput,
} from '~/server/schema/user.schema';
import { usersSearchIndex } from '~/server/search-index';
import type {
  BadgeCosmetic,
  ContentDecorationCosmetic,
  StickerCosmetic,
  NamePlateCosmetic,
  ProfileBackgroundCosmetic,
  WithClaimKey,
} from '~/server/selectors/cosmetic.selector';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { getUserNotificationCount } from '~/server/services/notification.service';
import { getPendingPlacementCounts } from '~/server/services/placement.service';
import { queueModelMetricPrivacyReindex } from '~/server/services/model.service';
import { getUserResourceReview } from '~/server/services/resourceReview.service';
import {
  createCustomer,
  deleteCustomerPaymentMethod,
  getCustomerPaymentMethods,
} from '~/server/services/stripe.service';
import {
  BlockedByUsers,
  BlockedUsers,
  HiddenUsers,
} from '~/server/services/user-preferences.service';
import {
  claimCosmetic,
  createUserReferral,
  deleteUser,
  deleteUserProfilePictureCache,
  equipCosmetic,
  getCreators,
  getUserBookmarkCollections,
  getBanContentPreview,
  getUserById,
  getUserByUsername,
  getUserCosmetics,
  getUserCreator,
  getUserDownloadedModelVersions,
  getUserEngagedModelsByIds,
  getUserEngagedModelVersions,
  getUserList,
  getUserPurchasedRewards,
  getUsers,
  getUserContentSettings,
  getUserSettings,
  setAlertDismissed,
  getUsersWithSearch,
  isUsernamePermitted,
  restoreUser,
  setLeaderboardEligibility,
  setUserSetting,
  patchUserSettings,
  splitSettingsPatch,
  toggleBan,
  toggleBookmarked,
  toggleContestBan,
  toggleFollowUser,
  toggleModelEngagement,
  toggleModelNotify,
  toggleReview,
  toggleUserArticleEngagement,
  toggleUserBountyEngagement,
  unequipCosmeticByType,
  updateLeaderboardRank,
  updateLeaderboardRankForUsers,
  updateUserById,
  userByReferralCode,
} from '~/server/services/user.service';
import { assertEmailAllowed } from '~/server/services/blocklist.service';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
  withRetries,
} from '~/server/utils/errorHandling';
import { boundExcludedUserIds } from '~/server/utils/excluded-user-ids';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { invalidateSession, refreshSession } from '~/server/auth/session-invalidation';
import { Flags } from '~/shared/utils/flags';
import type { ModelVersionEngagementType } from '~/shared/utils/prisma/enums';
import { CosmeticType, ModelEngagementType, UserEngagementType } from '~/shared/utils/prisma/enums';
import { isUUID } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import { getUserBuzzBonusAmount } from '../common/user-helpers';
import { verifyCaptchaToken } from '../recaptcha/client';
import { createBuzzTransaction } from '../services/buzz.service';
import type { FeatureAccess } from '../services/feature-flags.service';
import {
  computeUserFeatureFlagsOverlay,
  defaultToggleableFeatures,
} from '../services/feature-flags.service';
import {
  getEntityCoverImage,
  ingestImage,
  queueReplacedImageDeletion,
} from '../services/image.service';
import { TransactionType } from '~/shared/constants/buzz.constants';

export const getAllUsersHandler = async ({
  input,
  ctx,
}: {
  input: GetAllUsersInput;
  ctx: Context;
}) => {
  try {
    const [blockedUsers, blockedByUsers] = await Promise.all([
      BlockedUsers.getCached({ userId: ctx.user?.id }),
      BlockedByUsers.getCached({ userId: ctx.user?.id }),
    ]);

    // Dedupe + cap the merged exclusion list before it feeds getUsers' raw `NOT IN`
    // (Prisma) / getUsersWithSearch — a heavily-blocked viewer otherwise overflows the
    // Postgres bind-param limit → P2029 → 500 (same class as comment.getAll). Ordering is a
    // load-bearing safety priority: pre-existing excluded ids (hidden-user prefs) first,
    // then the INVOLUNTARY blocked-by list, then the viewer's own block list (sacrificed
    // first on overflow). See boundExcludedUserIds.
    input.excludedUserIds = boundExcludedUserIds(
      input.excludedUserIds ?? [],
      blockedByUsers.map((u) => u.id),
      blockedUsers.map((u) => u.id)
    );

    const searchMethod =
      ctx.user?.isModerator && input.contestBanned ? getUsers : getUsersWithSearch;

    const users = await searchMethod({
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
  ctx,
}: {
  input: GetUserByUsernameSchema;
  ctx: Context;
}) => {
  username = username?.toLowerCase();
  if (!username && !id) throw throwBadRequestError('Must provide username or id');
  if (id === constants.system.user.id || username === constants.system.user.username) return null;

  try {
    const user = await getUserCreator({
      username,
      id,
      leaderboardId,
      isModerator: ctx.user?.isModerator,
    });
    if (!user) throw throwNotFoundError('Could not find user');
    if (!ctx.user?.isModerator) user.excludeFromLeaderboards = false; // Mask from non-moderators

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
  ctx: ProtectedContext;
}) => {
  try {
    if (!(await isUsernamePermitted(input.username))) return false;
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

export const getNotificationSettingsHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
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

export const checkUserNotificationsHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  const { id } = ctx.user;

  try {
    // Concurrent, not serial: these hit two different backends — the
    // notifications service over HTTP (with its own retries) and the main
    // Postgres replica — with no data dependency between them. Awaiting them in
    // sequence tacked a full DB round trip onto a request already waiting on a
    // retrying HTTP call.
    const [unreadCount, placementCounts] = await Promise.all([
      getUserNotificationCount({ userId: id, unread: true }),
      // Degrades to zeroes rather than failing the request, matching
      // getUserNotificationCount: an under-reported badge for one session beats
      // taking the notification bell down with it.
      getPendingPlacementCounts({ ownerId: id }).catch(() => ({ sticker: 0, remix: 0 })),
    ]);

    const reduced = unreadCount.reduce(
      (acc, { category, count }) => {
        const key = category.toLowerCase() as Lowercase<NotificationCategory>;
        acc[key] = Number(count);
        acc['all'] += Number(count);
        return acc;
      },
      { all: 0 } as Record<Lowercase<NotificationCategory> | 'all', number>
    );

    // `pendingPlacements` rides along here rather than getting its own query:
    // this is the one request that already runs once per session for every
    // signed-in user (`staleTime: Infinity`, see useQueryNotificationsCount),
    // and the user menu badge needs a number on every page. A second per-page
    // count would be a production cost for a creator-only chore.
    //
    // Deliberately NOT folded into `all`: that number is the notification bell's
    // badge, and a pending placement is not an unread notification. Adding it
    // there would inflate the bell by rows the drawer cannot show and cannot
    // clear. It is also excluded by name from the client's mark-all-read wipe —
    // see NON_CATEGORY_COUNT_KEYS in notifications.utils.ts, which is where the
    // invariant for adding another non-category key to this payload lives.
    return {
      ...reduced,
      // One number for the menu entry, and the split for the segmented control
      // on the placements page — the entry points at both queues now, so a
      // sticker-only count would under-report the thing it links to.
      pendingPlacements: placementCounts.sticker + placementCounts.remix,
      pendingStickerPlacements: placementCounts.sticker,
      pendingRemixSubmissions: placementCounts.remix,
    };
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

/**
 * Cheap "whoami" for the authenticated caller, sourced entirely from the
 * session/JWT (ctx.user) — no DB round-trip. Works with API-key auth. Returns
 * the fields a headless/agent (MCP) caller needs to reason about its own
 * account: identity, onboarding state (raw bitflag + decoded steps + an
 * isOnboarded boolean), moderation/account flags, and tier/membership when
 * cheaply available on the session.
 *
 * Note: does NOT use simpleUserSelect (which omits muted / isModerator /
 * onboarding) — these come straight off the SessionUser.
 */
export const getSelfStatusHandler = ({ ctx }: { ctx: ProtectedContext }) => {
  const { user } = ctx;

  const onboardingSteps = Flags.instanceToArray(user.onboarding)
    .map((flag) => OnboardingSteps[flag] as keyof typeof OnboardingSteps | undefined)
    .filter((name): name is keyof typeof OnboardingSteps => !!name);

  return {
    id: user.id,
    username: user.username ?? null,
    onboarding: {
      raw: user.onboarding,
      completedSteps: onboardingSteps,
      isOnboarded: Flags.hasFlag(user.onboarding, OnboardingComplete),
    },
    muted: !!user.muted,
    isModerator: !!user.isModerator,
    bannedAt: user.bannedAt ?? null,
    deletedAt: user.deletedAt ?? null,
    tier: user.tier ?? null,
    subscriptionId: user.subscriptionId ?? null,
  };
};

export const completeOnboardingHandler = async ({
  input,
  ctx,
}: {
  input: UserOnboardingSchema;
  ctx: ProtectedContext;
}) => {
  try {
    const { domain } = ctx;
    const { id } = ctx.user;
    const onboarding = Flags.addFlag(ctx.user.onboarding, input.step);
    const changed = onboarding !== ctx.user.onboarding;

    switch (input.step) {
      case OnboardingSteps.TOS: {
        const now = new Date();
        // Store the accepted content hash alongside the date so a freshly-onboarded
        // user is hash-backed immediately and immune to stray `lastmod` bumps.
        const tos = await getStaticContent({ slug: ['tos'], ctx: { domain } as Context });
        const tosHash = resolveTosHash(tos.hash);
        await dbWrite.user.update({ where: { id }, data: { onboarding } });
        await setUserSetting(
          id,
          domain === 'green'
            ? { tosGreenLastSeenDate: now, tosGreenAcceptedHash: tosHash }
            : { tosLastSeenDate: now, tosAcceptedHash: tosHash }
        );
        break;
      }
      case OnboardingSteps.RedTOS: {
        const tos = await getStaticContent({ slug: ['tos'], ctx: { domain } as Context });
        await dbWrite.user.update({ where: { id }, data: { onboarding } });
        await setUserSetting(id, {
          tosRedLastSeenDate: new Date(),
          tosRedAcceptedHash: resolveTosHash(tos.hash),
        });
        break;
      }
      case OnboardingSteps.Profile: {
        if (input.username && !(await isUsernamePermitted(input.username)))
          throw throwBadRequestError('Invalid username');
        // OAuth providers that hand us no email (Reddit) land here with `email: null`, and this step
        // then REQUIRES one — free text that is never verified, which is the burner ring's door in.
        if (input.email && input.email !== ctx.user.email) await assertEmailAllowed(input.email);
        await dbWrite.user.update({
          where: { id },
          data: { onboarding, username: input.username, email: input.email },
        });
        break;
      }
      case OnboardingSteps.BrowsingLevels: {
        await dbWrite.user.update({
          where: { id },
          data: { onboarding },
        });
        break;
      }
      case OnboardingSteps.Buzz: {
        const { recaptchaToken, captchaDebug } = input;
        if (!recaptchaToken) throw throwAuthorizationError('recaptchaToken required');

        const validCaptcha = await verifyCaptchaToken({
          token: recaptchaToken,
          secret: env.CF_MANAGED_TURNSTILE_SECRET,
          ip: ctx.ip,
          meta: { source: 'onboarding-buzz', userId: id, ...(captchaDebug ?? {}) },
        });
        if (!validCaptcha) throw throwAuthorizationError('Recaptcha Failed. Please try again.');

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
            amount: getUserBuzzBonusAmount(),
            description: 'Onboarding bonus',
            type: TransactionType.Reward,
            externalTransactionId: `${ctx.user.id}-onboarding-bonus`,
            toAccountType: 'blue',
          })
        ).catch(handleLogError);
        break;
      }
    }

    // The session user carries `onboarding` (and username/email) from the SHARED session cache: post-cutover the
    // main app READS the cached SessionUser, it no longer recomputes it per request. Bust that cache so the
    // client's next session read reflects the advanced step — without this the stale cached `onboarding` makes a
    // NEW user repeat the same step forever ("can't get through account creation"). Mirrors updateUserHandler.
    //
    // 🔴 Gating on `changed` ALONE is narrower than what this handler WRITES. The Profile step writes
    // `username`/`email` unconditionally (see the switch above), and both are carried on the session shape — so a
    // re-submit of a step whose bit is already set advanced nothing, skipped the bust, and left the new username
    // in the database with the old one in the session for the rest of its 4h TTL. Bust on either condition.
    const wroteSessionIdentity =
      input.step === OnboardingSteps.Profile && (!!input.username || !!input.email);
    // Best-effort, like the sibling call in `user.service.ts:updateUserContentSettings`. The onboarding
    // step above is already COMMITTED by the time we get here, so letting an invalidation failure reach
    // the `catch` below would `throwDbError` a mutation that succeeded — the client is told the step
    // failed and re-submits an already-applied write. A failed bust degrades to staleness bounded by the
    // entry's own 4h TTL, which is strictly better than that. Logged, never swallowed silently.
    if (changed || wroteSessionIdentity)
      await refreshSession(id, { caller: 'profile' }).catch(handleLogError);

    const isComplete = onboarding === OnboardingComplete;
    if (isComplete && changed && onboardingCompletedCounter) onboardingCompletedCounter.inc();
  } catch (e) {
    const err = e as Error;
    // A TRPCError here is a policy REFUSAL (blocked domain, undeliverable domain, rejected
    // username), not a fault. Counting those inflates the error signal and hides the refusal rate.
    if (!(e instanceof TRPCError) && !err.message.includes('constraint failed'))
      onboardingErrorCounter?.inc();
    if (e instanceof TRPCError) throw e;
    throw throwDbError(e);
  }
};

export const updateUserHandler = async ({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: Partial<UserUpdateInput>;
}) => {
  const {
    id,
    badgeId,
    nameplateId,
    profileDecorationId,
    profileBackgroundId,
    username,
    source,
    landingPage,
    userReferralCode,
    profilePicture: inputProfilePicture,
    ...data
  } = input;
  const currentUser = ctx.user;
  if (id !== currentUser.id) throw throwAuthorizationError();
  if (username && !(await isUsernamePermitted(username)))
    throw throwBadRequestError('Invalid username');

  if (data.image) {
    const valid = verifyAvatar(data.image);
    if (!valid) throw throwBadRequestError('Invalid avatar URL');
  }

  // Drop invalid avatar references (e.g. a client-only `blob:` URL from a stale
  // upload bundle) instead of persisting them. We don't throw here so the rest of
  // the profile still saves — the avatar simply isn't updated with the bad value.
  const profilePicture =
    inputProfilePicture?.url && !verifyAvatar(inputProfilePicture.url)
      ? undefined
      : inputProfilePicture;

  try {
    const user = await getUserById({ id, select: { profilePictureId: true } });
    if (!user) throw throwNotFoundError(`No user with id ${id}`);

    const payloadCosmeticIds: number[] = [];
    const unequipPromises: Promise<unknown>[] = [];
    if (badgeId) payloadCosmeticIds.push(badgeId);
    else if (badgeId === null)
      unequipPromises.push(unequipCosmeticByType({ userId: id, type: CosmeticType.Badge }));

    if (nameplateId) payloadCosmeticIds.push(nameplateId);
    else if (nameplateId === null)
      unequipPromises.push(unequipCosmeticByType({ userId: id, type: CosmeticType.NamePlate }));

    if (profileDecorationId) payloadCosmeticIds.push(profileDecorationId);
    else if (profileDecorationId === null)
      unequipPromises.push(
        unequipCosmeticByType({ userId: id, type: CosmeticType.ProfileDecoration })
      );

    if (profileBackgroundId) payloadCosmeticIds.push(profileBackgroundId);
    else if (profileBackgroundId === null)
      unequipPromises.push(
        unequipCosmeticByType({ userId: id, type: CosmeticType.ProfileBackground })
      );

    await Promise.all(unequipPromises);

    const isSettingCosmetics = payloadCosmeticIds.length > 0;

    const updatedUser = await updateUserById({
      id,
      data: {
        ...data,
        username,
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
      updateSource: 'updateUser',
    });

    // Post-update operations â€” parallelize independent work
    const postUpdatePromises: Promise<unknown>[] = [];

    // Queue the old profilePic for a DEFERRED reap, and ingest the new one.
    //
    // This used to be an inline `deleteImageById`, which destroyed the row and the stored
    // object the instant the new picture saved. The write is instant; the references are
    // not — the image CDN caches its redirect for 24h, the account-switcher roster in
    // localStorage is durable by design, and other surfaces hold rendered avatar urls. None
    // of those are bugs on their own; they only became user-visible breakage because the
    // target was *gone* rather than merely *stale*. Queuing instead keeps the old picture
    // fetchable for the retention window, so every one of those caches self-corrects.
    if (user.profilePictureId && profilePicture && user.profilePictureId !== profilePicture.id) {
      postUpdatePromises.push(queueReplacedImageDeletion([user.profilePictureId]));
    }

    if (
      profilePicture &&
      updatedUser.profilePictureId &&
      user.profilePictureId !== profilePicture?.id
    ) {
      postUpdatePromises.push(
        ingestImage({
          image: {
            id: updatedUser.profilePictureId,
            url: profilePicture.url,
            type: profilePicture.type,
            height: profilePicture.height,
            width: profilePicture.width,
          },
        }).then(() => deleteUserProfilePictureCache(id))
      );
    }

    if (isSettingCosmetics)
      postUpdatePromises.push(equipCosmetic({ userId: id, cosmeticId: payloadCosmeticIds }));

    // Without this the new showcase isn't visible until the nightly rebuild, up to 24h later.
    // The modal sends the field on every user-level save, so this recomputes on cosmetic
    // saves too. That is deliberate: comparing against the stored value would have to read
    // it back, and the only cheap read is the replica — an A->B->A save inside the
    // replication window would then compare equal and skip the recompute it needs. The
    // upsert is 0.87 ms and idempotent, so the redundant call costs less than that risk.
    if (input.leaderboardShowcase !== undefined)
      postUpdatePromises.push(updateLeaderboardRankForUsers({ userIds: id }));

    if (userReferralCode || source || landingPage) {
      postUpdatePromises.push(
        createUserReferral({
          id: updatedUser.id,
          userReferralCode,
          source,
          landingPage,
          ip: ctx.ip,
        })
      );
    }

    postUpdatePromises.push(
      usersSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }])
    );

    purgeCache({ tags: [`user-creator-${id}`] }).catch();

    // The `.catch` is attached BEFORE the push, not around the `Promise.all` below: this batch runs after
    // the user row is already written, and `Promise.all` rejects on the FIRST rejection, so an unguarded
    // cache bust here both `throwDbError`s a committed write and masks whatever the other members did.
    // Guarding this one member keeps the rest of the batch reporting its own failures normally.
    postUpdatePromises.push(refreshSession(id, { caller: 'profile' }).catch(handleLogError));

    await Promise.all(postUpdatePromises);

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
  ctx: ProtectedContext;
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

export const restoreUserHandler = async ({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: RestoreUserInput;
}) => {
  const { id } = input;
  try {
    const result = await restoreUser(input);

    await ctx.track.userActivity({
      targetUserId: id,
      type: 'Account restoration',
    });

    return result;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

// Per-visible-set membership handler. Replaced the removed unbounded
// `getUserEngagedModelsHandler`, whose whole-history response was a serialize-freeze
// source. Bounded input → bounded response, so there is no cache: the tiny,
// index-scannable payload isn't worth the combinatorial keyspace + bust-site sprawl.
export const getUserEngagedModelsByIdsHandler = async ({
  input,
  ctx,
}: {
  input: GetEngagedModelsByIdsInput;
  ctx: ProtectedContext;
}) => {
  const { id } = ctx.user;
  try {
    return await getUserEngagedModelsByIds({ id, modelIds: input.modelIds });
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
  ctx: ProtectedContext;
}) => {
  const userId = ctx.user.id;
  const versions = await dbRead.modelVersion.findMany({
    where: { modelId: input.id },
    select: { id: true },
  });
  const modelVersionIds = versions.map((x) => x.id);

  try {
    const engagements = await getUserEngagedModelVersions({ userId, modelVersionIds });
    const downloads = await getUserDownloadedModelVersions({ userId, modelVersionIds });

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
        // Count published models in the DB instead of fetching every published
        // model id per creator just to take `.length`. The only consumer
        // (src/pages/api/v1/creators.ts) reads modelCount, not the model rows.
        _count: { select: { models: { where: { status: 'Published' } } } },
        image: true,
      },
    });

    return getPagingData(results, take, page);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getUserFollowingListHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  try {
    return await getUserFollows(ctx.user.id);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const getUserListsHandler = async ({ input }: { input: GetByUsernameSchema }) => {
  try {
    const { username } = input;

    const user = await getUserByUsername({ username, select: { id: true } });
    if (!user) throw throwNotFoundError(`No user with username ${username}`);

    const filteredUsers = [-1, user.id]; // Exclude civitai user and the user themselves

    const [followingCount, followersCount] = await dbRead.$transaction([
      dbRead.userEngagement.count({
        where: {
          userId: user.id,
          type: UserEngagementType.Follow,
          targetUserId: { notIn: filteredUsers },
        },
      }),
      dbRead.userEngagement.count({
        where: {
          targetUserId: user.id,
          type: UserEngagementType.Follow,
          userId: { notIn: filteredUsers },
        },
      }),
    ]);

    // Get blocked users separately since it uses cache
    const [hiddenUsers, blockedUsers] = await Promise.all([
      HiddenUsers.getCached({ userId: user.id }),
      BlockedUsers.getCached({ userId: user.id }),
    ]);

    return {
      followingCount,
      followersCount,
      hiddenCount: hiddenUsers.length,
      blockedCount: blockedUsers.length,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const getUserListHandler = async ({ input }: { input: GetUserListSchema }) => {
  try {
    return await getUserList(input);
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
  ctx: ProtectedContext;
}) => {
  try {
    const { ip, user } = ctx;
    const { id: userId } = user;
    const following = await toggleFollowUser({ ...input, userId });
    if (following) {
      await firstDailyFollowReward.apply({ followingId: input.targetUserId, userId }, { ip });
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

    return { following };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getUserHiddenListHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
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

export async function toggleFavoriteHandler({
  input: { modelId, modelVersionId, setTo },
  ctx,
}: {
  input: ToggleFavoriteInput;
  ctx: ProtectedContext;
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
    // Need dbWrite to avoid propagation lag
    const userModelReviews = await getUserResourceReview({ userId, modelId, tx: dbWrite });

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

  await redis.del(`${REDIS_KEYS.USER.BASE}:${userId}:${REDIS_SUB_KEYS.USER.MODEL_ENGAGEMENTS}`);

  return reviewResult;
}

export const toggleNotifyModelHandler = async ({
  input,
  ctx,
}: {
  input: ToggleModelEngagementInput;
  ctx: ProtectedContext;
}) => {
  try {
    const { id: userId } = ctx.user;
    const result = input.type
      ? await toggleModelEngagement({
          modelId: input.modelId,
          type: input.type,
          setTo: input.setTo,
          userId,
        })
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
    await redis.del(`${REDIS_KEYS.USER.BASE}:${userId}:${REDIS_SUB_KEYS.USER.MODEL_ENGAGEMENTS}`);

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
            downloadCountAllTime: true,
            thumbsUpCountAllTime: true,
            uploadCountAllTime: true,
            answerCountAllTime: true,
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
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
}) => {
  if (!ctx.user.isModerator) throw throwAuthorizationError();

  const { id } = input;
  const user = await getUserById({ id, select: { muted: true } });
  if (!user) throw throwNotFoundError(`No user with id ${id}`);

  const date = new Date();

  const updatedUser = await updateUserById({
    id,
    data: {
      muted: !user.muted,
      mutedAt: !user.muted ? date : undefined,
    },
    updateSource: 'toggleMute',
  });
  await invalidateSession(id, 'moderation');

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
  input: ToggleBanUser;
  ctx: ProtectedContext;
}) => {
  if (!ctx.user.isModerator) throw throwAuthorizationError();

  if (input.type === 'contest') {
    // Only ban the user from contests
    const updatedUser = await toggleContestBan({ ...input, userId: ctx.user.id });
    return updatedUser;
  }

  const updatedUser = await toggleBan({ ...input, userId: ctx.user.id, isModerator: true });

  await ctx.track.userActivity({
    type: updatedUser.bannedAt ? 'Banned' : 'Unbanned',
    targetUserId: updatedUser.id,
  });

  return updatedUser;
};

export const getBanContentPreviewHandler = async ({
  input,
}: {
  input: GetBanContentPreviewInput;
  ctx: ProtectedContext;
}) => {
  return getBanContentPreview({ userId: input.userId });
};

export const getUserCosmeticsHandler = async ({
  input,
  ctx,
}: {
  input?: GetUserCosmeticsSchema;
  ctx: ProtectedContext;
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
      (
        acc,
        {
          obtainedAt,
          equippedToId,
          equippedToType,
          claimKey,
          cosmetic,
          data: userData,
          forId,
          forType,
        }
      ) => {
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
        else if (type === CosmeticType.ContentDecoration) {
          const contentDecorationData = data as ContentDecorationCosmetic['data'];
          const uData = userData as ContentDecorationCosmetic['data'];
          if (uData) {
            contentDecorationData.lights = uData.lights;
          }
          acc.contentDecorations.push({
            ...sharedData,
            data: contentDecorationData,
          });
        } else if (type === CosmeticType.ProfileBackground)
          acc.profileBackground.push({
            ...sharedData,
            data: data as ProfileBackgroundCosmetic['data'],
          });
        else if (type === CosmeticType.Sticker)
          acc.sticker.push({ ...sharedData, data: data as StickerCosmetic['data'] });

        return acc;
      },
      {
        badges: [] as WithClaimKey<BadgeCosmetic>[],
        nameplates: [] as WithClaimKey<NamePlateCosmetic>[],
        profileDecorations: [] as WithClaimKey<ContentDecorationCosmetic>[],
        profileBackground: [] as WithClaimKey<ProfileBackgroundCosmetic>[],
        contentDecorations: [] as WithClaimKey<ContentDecorationCosmetic>[],
        sticker: [] as WithClaimKey<StickerCosmetic>[],
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
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
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

export const userByReferralCodeHandler = async ({ input }: { input: UserByReferralCodeSchema }) => {
  try {
    return await userByReferralCode(input);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const userRewardDetailsHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  try {
    // TODO.Optimization: This will make multiple requests to redis, we could probably do it in one and make this faster. This will get slower as we add more Active rewards.
    // `visible` is compile-time ("the kind of reward we advertise"); a null here
    // is the runtime disable. Filtering `visible` first keeps an unadvertised
    // reward off the config read entirely.
    const rewardDetails = (
      await Promise.all(
        Object.values(rewards)
          .filter((x) => x.visible)
          .map((x) => x.getUserRewardDetails(ctx.user.id))
      )
    ).filter((x) => x !== null);

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
  ctx: ProtectedContext;
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

export const getUserPaymentMethodsHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
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
  ctx: ProtectedContext;
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

export const getUserFeatureFlagsHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  try {
    const { id } = ctx.user;
    const { features } = await getUserSettings(id);

    // Shared pure overlay computation — also used by the SSR seed in _app
    // getInitialProps so the injected initialData byte-matches this response.
    return computeUserFeatureFlagsOverlay(features, ctx.features);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const toggleUserFeatureFlagHandler = async ({
  input,
  ctx,
}: {
  input: ToggleFeatureInput;
  ctx: ProtectedContext;
}) => {
  try {
    const { id } = ctx.user;
    const { features = {} } = await getUserSettings(id);

    // The read decides what this ONE flag toggles to; it must not decide what gets
    // written. Only the toggled flag is sent, merged into `settings.features` by the
    // database, so a concurrent write to any other setting — or to another flag —
    // survives instead of being reverted to its read-time value.
    const value = isDefined(features[input.feature])
      ? input.value ?? !features[input.feature]
      : input.value ?? !defaultToggleableFeatures[input.feature];

    const settings = await patchUserSettings(id, {
      mergeInto: { features: { [input.feature]: value } },
    });

    return (settings.features ?? { [input.feature]: value }) as Partial<FeatureAccess>;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getUserSettingsHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  try {
    const { id } = ctx.user;
    // Return JSON settings *and* the User-column content toggles so the client
    // can patch all of them in a single React Query cache on mutation success.
    const settings = await getUserContentSettings(id);

    return settings;
  } catch (error) {
    throw throwDbError(error);
  }
};

/**
 * Settings keys that `setUserSettingsInput` can write AND that the auth hub folds into the cached
 * SessionUser (`apps/auth/src/lib/server/auth/session-shape.ts` — its `settingsSchema` reads
 * `allowAds`, `redBrowsingLevel`, `isEarlyAdopter`). Writing one of these without busting
 * `session:data2:{id}` leaves the session serving the old value for the rest of its 4h TTL.
 * Keep this in sync with that schema; `redBrowsingLevel` is intentionally excluded because this
 * endpoint cannot write it (see the gate below).
 */
const SESSION_PROJECTED_SETTING_KEYS = ['allowAds', 'isEarlyAdopter'] as const;

export const setUserSettingHandler = async ({
  input,
  ctx,
}: {
  input: SetUserSettingsInput;
  ctx: ProtectedContext;
}) => {
  try {
    const { id } = ctx.user;
    const { tourSettings: tour, ...restInput } = input;

    if (restInput.assistantPersonality && !ctx.features.assistantPersonality) {
      throw throwAuthorizationError('You do not have permission to perform this action');
    }

    // Read for COMPARISON only — the two side effects below fire on a change, so they
    // need the previous value. Nothing read here is written back: the patch carries
    // only the keys this request is changing, and the database merges them onto
    // whatever the column holds at write time. Spreading the read snapshot into the
    // write is what used to revert a concurrent notice dismissal / feature toggle.
    const restSettings = await getUserSettings(id);
    const newSettings = await patchUserSettings(id, {
      ...splitSettingsPatch(restInput),
      // Two levels deep: `mergeInto` alone would still let two writes to the SAME
      // tour (e.g. a `currentStep` bump racing a `completed` write) clobber each
      // other, which is how a tour's completion got lost mid-flight in practice.
      ...(tour && Object.keys(tour).length ? { deepMergeInto: { tourSettings: tour } } : {}),
    });

    const privacyKeys = ['hideModelBuzz', 'hideModelDownloads', 'hideModelGenerations'] as const;
    const metricPrivacyChanged = privacyKeys.some(
      (k) => k in restInput && (restSettings as Record<string, unknown>)[k] !== restInput[k]
    );
    if (metricPrivacyChanged) await queueModelMetricPrivacyReindex(id);

    // Some settings keys are PROJECTED ONTO THE SESSION by the auth hub — `shapeSessionUser`
    // reads `allowAds`, `redBrowsingLevel` and `isEarlyAdopter` out of `User.settings` and
    // folds them into the SessionUser — and the hub caches that projection in
    // `session:data2:{id}` for 4h. Without a bust the toggle reads as instantly applied
    // client-side (the `getSettings` cache is patched optimistically) while every session
    // read — and every Flipt evaluation built from it — keeps the OLD value until the entry
    // expires: the toggle appears to do nothing. `refreshSession` busts that cache and
    // signals the browser to re-pull. Awaited so the bust lands before the mutation returns;
    // same reason `updateContentSettings` awaits its own call.
    //
    // 🔴 This used to name `isEarlyAdopter` as "the one settings key projected onto the
    // session". It was not: `allowAds` is projected too and is writable through THIS
    // endpoint's schema, so turning ads off left the session serving `allowAds: true` for up
    // to 4h. The gate is a set now, so adding a projected key is one edit here rather than a
    // silent re-introduction of the same bug (#4298's defect class).
    // `redBrowsingLevel` is deliberately absent — it is not part of `setUserSettingsInput`;
    // it is written by `updateContentSettings`, which performs its own bust.
    //
    // Gated on a CHANGE, not on key presence, and compared against `restInput` — the keys
    // THIS request sent — rather than against the stored blob. Mirrors the
    // `metricPrivacyChanged` comparison directly above. (The payload no longer carries the
    // whole blob, so a presence check on it would no longer fire on unrelated toggles the
    // way it did when this handler rewrote everything; the change comparison is still the
    // right test, because re-sending the value a user already holds is not a change.)
    const sessionProjectedSettingChanged = SESSION_PROJECTED_SETTING_KEYS.some(
      (key) => key in restInput && restSettings[key] !== restInput[key]
    );
    // Best-effort — the settings write above has already committed, so an invalidation failure must not
    // reach the `throwDbError` below and report a succeeded mutation as a 500. Staleness is bounded by
    // the cached entry's own TTL; a misreported write is not bounded by anything.
    if (sessionProjectedSettingChanged)
      await refreshSession(id, { caller: 'profile' }).catch(handleLogError);

    return newSettings;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const dismissAlertHandler = async ({
  input,
  ctx,
}: {
  input: { alertId: string; dismiss: boolean };
  ctx: ProtectedContext;
}) => {
  try {
    const { id } = ctx.user;
    // One statement, computed over the stored array. The array is never read into
    // JS, so two dismissals of different notices arriving together both land.
    await setAlertDismissed(id, input.alertId, input.dismiss);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const restoreAlertHandler = async ({
  input,
  ctx,
}: {
  input: { alertId: string };
  ctx: ProtectedContext;
}) => {
  try {
    const { id } = ctx.user;
    // Same write path as `dismissAlert({ dismiss: false })`. It previously went through
    // the whole-blob merge instead, which had a second defect: `removeEmpty` drops an
    // EMPTY array, so restoring the user's last remaining dismissal wrote nothing at
    // all and the notice stayed hidden.
    await setAlertDismissed(id, input.alertId, false);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getUserBookmarkCollectionsHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  return getUserBookmarkCollections({
    userId: ctx.user.id,
  });
};

export const getUserPurchasedRewardsHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  try {
    return getUserPurchasedRewards({
      userId: ctx.user.id,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export async function setLeaderboardEligibilityHandler({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: SetLeaderboardEligibilitySchema;
}) {
  await setLeaderboardEligibility(input);
  await ctx.track.userActivity({
    type: input.setTo ? 'ExcludedFromLeaderboard' : 'UnexcludedFromLeaderboard',
    targetUserId: input.id,
  });
}
