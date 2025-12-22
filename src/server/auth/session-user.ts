import type { Prisma } from '@prisma/client';
import type { SessionUser } from 'next-auth';
import { env } from '~/env/server';
import { CacheTTL } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { withRetries } from '~/utils/errorHandling';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { UserMeta, UserSubscriptionsByBuzzType } from '~/server/schema/user.schema';
import { userSettingsSchema } from '~/server/schema/user.schema';
import { getSystemPermissions } from '~/server/services/system-cache';
import { getUserBanDetails } from '~/utils/user-helpers';
import type { UserTier } from '~/server/schema/user.schema';
import { invalidateCivitaiUser } from '~/server/services/orchestrator/civitai';

export const getSessionUser = async ({ userId, token }: { userId?: number; token?: string }) => {
  if (!userId && !token) return undefined;

  return withRetries(
    async () => {
      // Get UserId from Token
      if (!userId && token) {
        const now = new Date();
        const result = await dbWrite.apiKey.findFirst({
          where: { key: token, OR: [{ expiresAt: { gte: now } }, { expiresAt: null }] },
          select: { userId: true },
        });
        if (!result) return undefined;
        userId = result.userId;
      }
      if (!userId) return undefined;

      // Get from cache
      // ----------------------------------
      const cacheKey = `${REDIS_KEYS.USER.SESSION}:${userId}` as const;
      const cachedResult = await redis.packed.get<SessionUser | null>(cacheKey);
      if (cachedResult && !('clearedAt' in cachedResult)) return cachedResult;

      // On cache miss get from database
      // ----------------------------------
      const where: Prisma.UserWhereInput = { deletedAt: null, id: userId };

      // console.log(new Date().toISOString() + ' ::', 'running query');
      // console.trace();

      // TODO switch from prisma, or try to make this a direct/raw query
      const response = await dbWrite.user.findFirst({
        where,
        include: {
          referral: { select: { id: true } },
          profilePicture: {
            select: {
              id: true,
              url: true,
              // nsfw: true,
              hash: true,
              userId: true,
            },
          },
        },
      });
      // Get ALL user subscriptions (one per buzzType)
      const allSubscriptions = await dbWrite.customerSubscription.findMany({
        where: {
          userId,
          status: { notIn: ['canceled', 'incomplete_expired', 'past_due', 'unpaid'] },
        },
        include: {
          product: true,
          price: true,
        },
      });

      if (!response) return undefined;

      // nb: doing this because these fields are technically nullable, but prisma
      // likes returning them as undefined. that messes with the typing.
      const { banDetails, ...userMeta } = (response.meta ?? {}) as UserMeta;

      // Build subscriptions object per buzzType
      const subscriptionsByBuzzType: UserSubscriptionsByBuzzType = {};

      let highestTier: UserTier | undefined = undefined;
      let primarySubscriptionId: string | undefined = undefined;
      let memberInBadState = false;

      const tierOrder: Record<string, number> = {
        founder: 5,
        gold: 4,
        silver: 3,
        bronze: 2,
        free: 1,
      };

      for (const sub of allSubscriptions) {
        const metadata = sub.product.metadata as any;
        const tier = metadata?.[env.TIER_METADATA_KEY] as UserTier | undefined;
        const isActive = ['active', 'trialing'].includes(sub.status);
        const isBadState = ['incomplete', 'incomplete_expired', 'past_due', 'unpaid'].includes(
          sub.status
        );

        if (isBadState) memberInBadState = true;

        if (tier && tier !== 'free') {
          subscriptionsByBuzzType[sub.buzzType] = {
            tier,
            isMember: isActive,
            subscriptionId: sub.id,
            status: sub.status,
          };

          // Track highest tier for backward compatibility
          if (!highestTier || (tierOrder[tier] ?? 0) > (tierOrder[highestTier] ?? 0)) {
            highestTier = tier;
            primarySubscriptionId = sub.id;
          }
        }
      }

      const tier = highestTier;

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
        paddleCustomerId: response.paddleCustomerId ?? undefined,
        mutedAt: response.mutedAt ?? undefined,
        muted: response.muted ?? undefined,
        bannedAt: response.bannedAt ?? undefined,
        autoplayGifs: response.autoplayGifs ?? undefined,
        leaderboardShowcase: response.leaderboardShowcase ?? undefined,
        filePreferences: (response.filePreferences ?? undefined) as UserFilePreferences | undefined,
        meta: userMeta,
        banDetails: getUserBanDetails({ meta: userMeta }),
        subscriptionId: primarySubscriptionId ?? undefined,
        subscriptions: subscriptionsByBuzzType,
      };

      const { profilePicture, profilePictureId, publicSettings, settings, ...rest } = user;

      const permissions: string[] = [];
      const systemPermissions = await getSystemPermissions();
      for (const [key, value] of Object.entries(systemPermissions)) {
        if (value.includes(user.id)) permissions.push(key);
      }

      // let feedbackToken: string | undefined;
      // if (!!user.username && !!user.email)
      //   feedbackToken = createFeaturebaseToken(user as { username: string; email: string });

      const userSettings = userSettingsSchema.safeParse(settings ?? {});

      const sessionUser: SessionUser = {
        ...rest,
        image: profilePicture?.url ?? rest.image,
        tier: !!tier ? tier : undefined,
        permissions,
        memberInBadState,
        allowAds:
          userSettings.success && userSettings.data.allowAds != null
            ? userSettings.data.allowAds
            : tier != null
            ? false
            : true,
        redBrowsingLevel:
          userSettings.success && userSettings.data.redBrowsingLevel != null
            ? userSettings.data.redBrowsingLevel
            : undefined,
        // feedbackToken,
      };

      await redis.packed.set(cacheKey, sessionUser, { EX: CacheTTL.hour * 4 });
      await invalidateCivitaiUser({ userId });

      return sessionUser;
    },
    2, // 2 retries = 3 total attempts
    100 // 100ms initial retry delay
  );
};
