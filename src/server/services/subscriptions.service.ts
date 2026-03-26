import type { TransactionNotification } from '@paddle/paddle-node-sdk';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import {
  subscriptionProductMetadataSchema,
  type GetUserSubscriptionInput,
  type SubscriptionMetadata,
} from '~/server/schema/subscriptions.schema';
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';
import { Prisma } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { TransactionType, type BuzzAccountType } from '~/shared/constants/buzz.constants';
import { upsertContact } from '~/server/integrations/freshdesk';

// const baseUrl = getBaseUrl();
// const log = createLogger('subscriptions', 'blue');

export const getPlans = async ({
  paymentProvider = PaymentProvider.Stripe,
  includeFree = false,
  includeInactive = false,
  interval = 'month',
  buzzType,
}: {
  paymentProvider?: PaymentProvider;
  includeFree?: boolean;
  includeInactive?: boolean;
  interval?: 'month' | 'year';
  buzzType?: string;
}) => {
  const products = await dbWrite.product.findMany({
    where: {
      provider: paymentProvider,
      active: includeInactive ? undefined : true,
      prices: { some: { type: 'recurring', active: true, interval } },
    },
    select: {
      id: true,
      name: true,
      description: true,
      metadata: true,
      defaultPriceId: true,
      provider: true,
      prices: {
        select: {
          id: true,
          interval: true,
          intervalCount: true,
          type: true,
          unitAmount: true,
          currency: true,
          metadata: true,
        },
        where: {
          active: true,
          interval: interval,
        },
      },
    },
  });

  // Only show the default price for a subscription product
  return products
    .map((product) => {
      const prices = product.prices.map((x) => ({ ...x, unitAmount: x.unitAmount ?? 0 }));
      const price = prices.filter((x) => x.id === product.defaultPriceId)[0] ?? prices[0];

      return {
        ...product,
        price,
        prices,
        metadata: subscriptionProductMetadataSchema.parse(product.metadata),
      };
    })
    .filter(({ metadata }) => {
      // Filter by tier (membership products)
      let hasTier = true;
      if (env.TIER_METADATA_KEY) {
        const key = env.TIER_METADATA_KEY as keyof typeof metadata;
        hasTier = !!metadata[key] && (metadata[key] !== 'free' || includeFree);
      }

      // Filter by buzzType if provided
      const matchesBuzzType = buzzType ? metadata.buzzType === buzzType : true;

      return hasTier && matchesBuzzType;
    })

    .sort((a, b) => (a.price?.unitAmount ?? 0) - (b.price?.unitAmount ?? 0));
};

export type SubscriptionPlan = Awaited<ReturnType<typeof getPlans>>[number];

export const getUserSubscription = async ({
  userId,
  buzzType,
  includeBadState,
}: GetUserSubscriptionInput & { buzzType?: string; includeBadState?: boolean }) => {
  // If buzzType is provided, use the composite unique key
  // Otherwise, get the first subscription (backward compatibility - defaults to yellow)
  const subscription = await dbWrite.customerSubscription.findFirst({
    where: { userId, buzzType: buzzType ?? 'yellow' }, // Default to yellow for backward compatibility
    select: {
      id: true,
      status: true,
      cancelAtPeriodEnd: true,
      cancelAt: true,
      canceledAt: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      createdAt: true,
      endedAt: true,
      metadata: true,
      buzzType: true,
      product: {
        select: {
          id: true,
          name: true,
          description: true,
          metadata: true,
          provider: true,
          active: true,
        },
      },
      price: {
        select: {
          id: true,
          unitAmount: true,
          interval: true,
          intervalCount: true,
          currency: true,
          active: true,
        },
      },
    },
  });

  // Statuses that always exclude a subscription (terminal states)
  const terminalStatuses = ['canceled', 'incomplete_expired'];
  // Statuses that are bad but can be recovered (show to user if includeBadState is true)
  const recoverableBadStatuses = ['past_due', 'unpaid'];

  if (!subscription) return null;

  // Always exclude terminal statuses
  if (terminalStatuses.includes(subscription.status)) return null;

  // Exclude recoverable bad statuses unless includeBadState is true
  if (!includeBadState && recoverableBadStatuses.includes(subscription.status)) return null;

  const productMeta = subscriptionProductMetadataSchema.parse(subscription.product.metadata);

  const subscriptionMeta = (subscription.metadata ?? {}) as SubscriptionMetadata;
  if (subscriptionMeta.renewalEmailSent) {
    // Makes it so that we don't consider this a "subscribed" user.
    return null;
  }

  return {
    ...subscription,
    price: {
      ...subscription.price,
      unitAmount: subscription.price.unitAmount ?? 0,
      interval: subscription.price.interval as 'month' | 'year',
    },
    isBadState: ['incomplete', 'incomplete_expired', 'past_due', 'unpaid'].includes(
      subscription.status
    ),
    tier: (productMeta?.[env.TIER_METADATA_KEY] ?? 'free') as string,
    productMeta,
    product: {
      ...subscription.product,
      metadata: productMeta,
    },
  };
};

export type UserSubscription = Awaited<ReturnType<typeof getUserSubscription>>;

// Get all active subscriptions for a user
export const getAllUserSubscriptions = async (userId: number) => {
  const subscriptions = await dbWrite.customerSubscription.findMany({
    where: {
      userId,
      status: { notIn: ['canceled', 'incomplete_expired', 'past_due', 'unpaid'] },
    },
    select: {
      id: true,
      status: true,
      cancelAtPeriodEnd: true,
      cancelAt: true,
      canceledAt: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      createdAt: true,
      endedAt: true,
      metadata: true,
      buzzType: true,
      product: {
        select: {
          id: true,
          name: true,
          description: true,
          metadata: true,
          provider: true,
          active: true,
        },
      },
      price: {
        select: {
          id: true,
          unitAmount: true,
          interval: true,
          intervalCount: true,
          currency: true,
          active: true,
        },
      },
    },
  });

  return subscriptions
    .map((subscription) => {
      const productMeta = subscriptionProductMetadataSchema.parse(subscription.product.metadata);
      const subscriptionMeta = (subscription.metadata ?? {}) as SubscriptionMetadata;

      // Filter out renewalEmailSent subscriptions
      if (subscriptionMeta.renewalEmailSent) return null;

      return {
        ...subscription,
        price: {
          ...subscription.price,
          unitAmount: subscription.price.unitAmount ?? 0,
          interval: subscription.price.interval as 'month' | 'year',
        },
        isBadState: ['incomplete', 'incomplete_expired', 'past_due', 'unpaid'].includes(
          subscription.status
        ),
        tier: (productMeta?.[env.TIER_METADATA_KEY] ?? 'free') as string,
        productMeta,
      };
    })
    .filter((sub) => sub !== null);
};

export type AllUserSubscriptions = Awaited<ReturnType<typeof getAllUserSubscriptions>>;

/**
 * Get the highest tier subscription for a user
 * @param userId - The user ID
 * @returns The subscription with the highest tier, or null if no subscriptions found
 */
export const getHighestTierSubscription = async (userId: number) => {
  const subscriptions = await getAllUserSubscriptions(userId);

  if (subscriptions.length === 0) return null;

  // Find the subscription with the highest tier using the tier hierarchy from constants
  return subscriptions.reduce((highest, current) => {
    const highestTierIndex = constants.memberships.tierOrder.indexOf(highest.tier as any);
    const currentTierIndex = constants.memberships.tierOrder.indexOf(current.tier as any);

    // If tier not found in hierarchy, treat as lowest (-1 < any valid index)
    return currentTierIndex > highestTierIndex ? current : highest;
  });
};

export const paddleTransactionContainsSubscriptionItem = async (data: TransactionNotification) => {
  const priceIds = data.items.map((i) => i.price?.id).filter(isDefined);

  if (priceIds.length === 0) {
    return false;
  }

  const products = await dbWrite.product.findMany({
    where: {
      provider: PaymentProvider.Paddle,
      prices: { some: { id: { in: priceIds } } },
    },
  });

  const nonFreeProducts = products.filter((p) => {
    const meta = subscriptionProductMetadataSchema.parse(p.metadata);
    return meta?.[env.TIER_METADATA_KEY] !== 'free';
  });

  return nonFreeProducts.length > 0;
};

/**
 * Delivers monthly cosmetics to users with active Civitai subscriptions.
 * TODO: This should be updated to do any provider not only Civitai.Not needed right now, but in the future
 * @param { userIds = [], tx }: { userIds?: number[]; tx?: Prisma.TransactionClient }
 * @returns {Promise<void>}
 */
export const deliverMonthlyCosmetics = async ({
  userIds = [],
  dateOverride,
  tx,
}: {
  userIds?: number[];
  dateOverride?: Date;
  tx?: Prisma.TransactionClient;
}) => {
  const client = tx ?? dbWrite;
  const date = dateOverride ?? new Date();
  const currentDay = date.getDate();

  await client.$executeRaw`
      with users_affected AS (
        SELECT
          "userId",
          COALESCE(pdl.id, pr.id) "productId",
          NOW() as "createdAt"
        FROM "CustomerSubscription" cs
        JOIN "Product" pr ON pr.id = cs."productId"
        JOIN "Price" p ON p.id = cs."priceId"
        LEFT JOIN "Product" pdl
          ON pdl.active
            AND jsonb_typeof(pr.metadata->'level') != 'undefined'
            AND jsonb_typeof(pdl.metadata->'level') != 'undefined'
            AND (pdl.metadata->>'level')::int <= (pr.metadata->>'level')::int
            AND pdl.provider = pr.provider
        WHERE ${
          userIds.length > 0
            ? Prisma.sql`cs."userId" IN (${Prisma.join(userIds)})`
            : Prisma.sql`
          (
          -- Exact day match (normal case)
          EXTRACT(day from cs."currentPeriodStart") = ${currentDay}
          OR
          -- Handle month-end edge cases (e.g., Jan 30th -> Feb 28th, Jan 31st -> Apr 30th)
          (
            EXTRACT(day from cs."currentPeriodStart") > EXTRACT(day from (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day'))
            AND ${currentDay} = EXTRACT(day from (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day'))
          )
        )
        `
        }
        AND status = 'active'
        AND "currentPeriodEnd" > NOW()
        AND "currentPeriodEnd"::date > NOW()::date -- Don't grant cosmetics on the expiration day
        AND pr.provider = 'Civitai'
        AND pr.metadata->>'monthlyBuzz' IS NOT NULL
      )
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "obtainedAt", "claimKey")
      SELECT DISTINCT
        p."userId",
        c.id "cosmeticId",
        now(),
        'claimed'
      FROM users_affected p
      JOIN "Cosmetic" c ON
        c."productId" = p."productId"
        AND (c."availableStart" IS NULL OR p."createdAt" >= c."availableStart")
        AND (c."availableEnd" IS NULL OR p."createdAt" <= c."availableEnd")
      ON CONFLICT ("userId", "cosmeticId", "claimKey") DO NOTHING;
    `;
};

/**
 * Manually sync a user's membership tier to Freshdesk
 */
export const syncFreshdeskMembership = async ({ userId }: { userId: number }) => {
  const user = await dbWrite.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, email: true },
  });

  if (!user) {
    throw new Error('User not found');
  }

  if (!user.email) {
    throw new Error('User has no email address');
  }

  const subscription = await getHighestTierSubscription(userId);
  const tier = subscription?.tier;

  await upsertContact({
    id: user.id,
    username: user.username ?? undefined,
    email: user.email,
    tier,
  });

  return { success: true, userId, tier };
};

export const claimPrepaidToken = async ({
  tokenId,
  userId,
}: {
  tokenId: string;
  userId: number;
}) => {
  const { getPrepaidTokens } = await import('~/server/utils/subscription.utils');
  const { createBuzzTransaction } = await import('~/server/services/buzz.service');

  // Mark as claimed in a short DB transaction first, then deliver buzz outside.
  // This keeps the transaction short (no network calls inside) and prevents double-spend.
  // If buzz delivery fails, token is "claimed but no buzz" — recoverable via retry
  // since createBuzzTransaction uses externalTransactionId for idempotency.
  const result = await dbWrite.$transaction(async (tx) => {
    const subscription = await tx.customerSubscription.findFirst({
      where: {
        userId,
        status: { in: ['active', 'expired_claimable'] },
        product: { provider: 'Civitai' },
      },
      select: {
        id: true,
        metadata: true,
        product: {
          select: { metadata: true },
        },
      },
    });

    if (!subscription) {
      throw new Error('No active prepaid membership found');
    }

    const meta = (subscription.metadata ?? {}) as import('~/server/schema/subscriptions.schema').SubscriptionMetadata;
    const tokens = getPrepaidTokens({ metadata: meta });
    const tokenIndex = tokens.findIndex((t) => t.id === tokenId);

    if (tokenIndex === -1) {
      throw new Error('Token not found');
    }

    const token = tokens[tokenIndex];

    if (token.status !== 'unlocked') {
      throw new Error(
        token.status === 'claimed' ? 'Token already claimed' : 'Token is still locked'
      );
    }

    const productMeta = subscription.product.metadata as import('~/server/schema/subscriptions.schema').SubscriptionProductMetadata;
    const buzzType = productMeta.buzzType ?? 'yellow';
    const externalTransactionId = `prepaid-token-claim:${tokenId}`;
    const now = new Date().toISOString();

    tokens[tokenIndex] = {
      ...token,
      status: 'claimed',
      claimedAt: now,
      buzzTransactionId: externalTransactionId,
    };

    const updatedMeta: Record<string, any> = { ...meta, tokens };

    // For legacy tokens: decrement prepaids counter if the metadata didn't already
    // have a tokens array (meaning the unlock job hasn't migrated this user yet).
    if (tokenId.startsWith('legacy_') && meta.prepaids && !meta.tokens?.length) {
      const tierKey = token.tier as keyof NonNullable<typeof meta.prepaids>;
      updatedMeta.prepaids = {
        ...meta.prepaids,
        [tierKey]: Math.max(0, (meta.prepaids[tierKey] ?? 0) - 1),
      };
      updatedMeta.buzzTransactionIds = [
        ...(meta.buzzTransactionIds ?? []),
        externalTransactionId,
      ];
    }

    await tx.customerSubscription.update({
      where: { id: subscription.id },
      data: {
        metadata: updatedMeta,
        updatedAt: new Date(),
      },
    });

    return {
      tokenId,
      buzzAmount: token.buzzAmount,
      tier: token.tier,
      buzzType: buzzType as BuzzAccountType,
      externalTransactionId,
    };
  });

  // Deliver buzz OUTSIDE the transaction — idempotent via externalTransactionId
  await createBuzzTransaction({
    fromAccountId: 0,
    toAccountId: userId,
    toAccountType: result.buzzType,
    type: TransactionType.Purchase,
    externalTransactionId: result.externalTransactionId,
    amount: result.buzzAmount,
    description: `Claimed prepaid ${result.tier} token`,
    details: {
      type: 'prepaid-token-claim',
      tokenId: result.tokenId,
      tier: result.tier,
    },
  });

  const { invalidateSubscriptionCaches } = await import('~/server/utils/subscription.utils');
  await invalidateSubscriptionCaches(userId);

  return result;
};

export const claimAllPrepaidTokens = async ({ userId }: { userId: number }) => {
  const { getPrepaidTokens } = await import('~/server/utils/subscription.utils');
  const { createBuzzTransactionMany } = await import('~/server/services/buzz.service');

  // Short DB transaction to mark all tokens as claimed, then deliver buzz outside.
  const result = await dbWrite.$transaction(async (tx) => {
    const subscription = await tx.customerSubscription.findFirst({
      where: {
        userId,
        status: { in: ['active', 'expired_claimable'] },
        product: { provider: 'Civitai' },
      },
      select: {
        id: true,
        metadata: true,
        product: {
          select: { metadata: true },
        },
      },
    });

    if (!subscription) {
      throw new Error('No active prepaid membership found');
    }

    const meta = (subscription.metadata ?? {}) as import('~/server/schema/subscriptions.schema').SubscriptionMetadata;
    const tokens = getPrepaidTokens({ metadata: meta });
    const unlockedTokens = tokens.filter((t) => t.status === 'unlocked');

    if (unlockedTokens.length === 0) {
      throw new Error('No unlocked tokens to claim');
    }

    const productMeta = subscription.product.metadata as import('~/server/schema/subscriptions.schema').SubscriptionProductMetadata;
    const buzzType = productMeta.buzzType ?? 'yellow';
    const now = new Date().toISOString();

    const updatedTokens = tokens.map((t) => {
      if (t.status === 'unlocked') {
        return {
          ...t,
          status: 'claimed' as const,
          claimedAt: now,
          buzzTransactionId: `prepaid-token-claim:${t.id}`,
        };
      }
      return t;
    });

    const updatedMeta: Record<string, any> = { ...meta, tokens: updatedTokens };

    // For legacy tokens: decrement prepaids if not yet migrated to tokens array
    const legacyClaimed = unlockedTokens.filter((t) => t.id.startsWith('legacy_'));
    if (legacyClaimed.length > 0 && meta.prepaids && !meta.tokens?.length) {
      const updatedPrepaids = { ...meta.prepaids };
      const newTxIds = [...(meta.buzzTransactionIds ?? [])];
      for (const t of legacyClaimed) {
        const tierKey = t.tier as keyof typeof updatedPrepaids;
        updatedPrepaids[tierKey] = Math.max(0, (updatedPrepaids[tierKey] ?? 0) - 1);
        newTxIds.push(`prepaid-token-claim:${t.id}`);
      }
      updatedMeta.prepaids = updatedPrepaids;
      updatedMeta.buzzTransactionIds = newTxIds;
    }

    await tx.customerSubscription.update({
      where: { id: subscription.id },
      data: {
        metadata: updatedMeta,
        updatedAt: new Date(),
      },
    });

    const totalBuzz = unlockedTokens.reduce((sum, t) => sum + t.buzzAmount, 0);
    return {
      claimed: unlockedTokens.length,
      totalBuzz,
      buzzType: buzzType as BuzzAccountType,
      unlockedTokens,
    };
  });

  // Deliver buzz OUTSIDE the transaction — idempotent via externalTransactionId
  const transactions = result.unlockedTokens.map((token) => ({
    fromAccountId: 0,
    toAccountId: userId,
    toAccountType: result.buzzType,
    type: TransactionType.Purchase,
    externalTransactionId: `prepaid-token-claim:${token.id}`,
    amount: token.buzzAmount,
    description: `Claimed prepaid ${token.tier} token`,
    details: {
      type: 'prepaid-token-claim',
      tokenId: token.id,
      tier: token.tier,
    },
  }));

  await createBuzzTransactionMany(transactions);

  const { invalidateSubscriptionCaches } = await import('~/server/utils/subscription.utils');
  await invalidateSubscriptionCaches(userId);

  return { claimed: result.claimed, totalBuzz: result.totalBuzz };
};

/**
 * Unlock tokens for a specific user (admin/mod endpoint). This does the full process:
 * 1. Reads subscription metadata (supports both new tokens and legacy prepaids)
 * 2. When force=false: unlocks one locked token matching the current tier
 * 3. When force=true: unlocks ALL locked tokens matching the current tier
 * 4. Persists updated metadata (migrating legacy prepaids → tokens if needed)
 * 5. Sends notification email
 */
export const unlockTokensForUser = async ({
  userId,
  force = false,
}: {
  userId: number;
  /** When true, unlocks ALL locked tokens regardless of unlock date */
  force?: boolean;
}) => {
  const { getPrepaidTokens } = await import('~/server/utils/subscription.utils');
  const { prepaidTokenUnlockedEmail } = await import(
    '~/server/email/templates/prepaidTokenUnlocked.email'
  );

  const subscription = await dbWrite.customerSubscription.findFirst({
    where: {
      userId,
      status: 'active',
      product: { provider: 'Civitai' },
    },
    select: {
      id: true,
      metadata: true,
      currentPeriodStart: true,
      product: {
        select: { metadata: true },
      },
      user: {
        select: { email: true, username: true },
      },
    },
  });

  if (!subscription) {
    throw new Error('No active prepaid membership found');
  }

  const meta = (subscription.metadata ?? {}) as import('~/server/schema/subscriptions.schema').SubscriptionMetadata;
  const productMeta = subscription.product.metadata as import('~/server/schema/subscriptions.schema').SubscriptionProductMetadata;
  const currentTier = productMeta.tier;

  if (!currentTier || currentTier === 'free') {
    return { unlocked: 0, totalBuzz: 0, message: 'Subscription has no paid tier' };
  }

  const tokens = getPrepaidTokens({ metadata: meta });

  if (tokens.length === 0) {
    return { unlocked: 0, totalBuzz: 0, message: 'No tokens found' };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  let unlockedCount = 0;
  let totalBuzz = 0;

  let updatedTokens: typeof tokens;
  if (force) {
    // Unlock ALL locked tokens matching the current tier only
    updatedTokens = tokens.map((token) => {
      if (token.status === 'locked' && token.tier === currentTier) {
        unlockedCount++;
        totalBuzz += token.buzzAmount;
        return { ...token, status: 'unlocked' as const, unlockedAt: nowIso };
      }
      return token;
    });
  } else {
    // Unlock ONE locked token matching the current tier
    const targetIndex = tokens.findIndex(
      (t) => t.status === 'locked' && t.tier === currentTier
    );

    if (targetIndex === -1) {
      return { unlocked: 0, totalBuzz: 0, message: `No locked ${currentTier} tokens to unlock` };
    }

    updatedTokens = tokens.map((token, i) => {
      if (i === targetIndex) {
        unlockedCount++;
        totalBuzz += token.buzzAmount;
        return { ...token, status: 'unlocked' as const, unlockedAt: nowIso };
      }
      return token;
    });
  }

  if (unlockedCount === 0) {
    return { unlocked: 0, totalBuzz: 0, message: 'No tokens eligible for unlock yet' };
  }

  // Persist — write full tokens array (this migrates legacy prepaids to new format)
  await dbWrite.customerSubscription.update({
    where: { id: subscription.id },
    data: {
      metadata: { ...meta, tokens: updatedTokens },
      updatedAt: now,
    },
  });

  const { invalidateSubscriptionCaches } = await import('~/server/utils/subscription.utils');
  await invalidateSubscriptionCaches(userId);

  // Send notification email
  if (subscription.user?.email) {
    try {
      await prepaidTokenUnlockedEmail.send({
        user: {
          email: subscription.user.email,
          username: subscription.user.username ?? 'there',
        },
        tokensUnlocked: unlockedCount,
        totalBuzz,
      });
    } catch (err) {
      console.error(`Failed to send token unlock email to user ${userId}:`, err);
    }
  }

  return { unlocked: unlockedCount, totalBuzz };
};
