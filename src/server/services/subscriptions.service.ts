import type { TransactionNotification } from '@paddle/paddle-node-sdk';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import type {
  GetUserSubscriptionInput,
  SubscriptionMetadata,
  SubscriptionProductMetadata,
} from '~/server/schema/subscriptions.schema';
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';
import { Prisma } from '@prisma/client';

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
    .filter(({ metadata }) => {
      const productMeta = metadata as SubscriptionProductMetadata;

      // Filter by tier (membership products)
      const hasTier = env.TIER_METADATA_KEY
        ? !!(metadata as any)?.[env.TIER_METADATA_KEY] &&
          ((metadata as any)?.[env.TIER_METADATA_KEY] !== 'free' || includeFree)
        : true;

      // Filter by buzzType if provided
      const matchesBuzzType = buzzType ? (productMeta.buzzType ?? 'yellow') === buzzType : true;

      return hasTier && matchesBuzzType;
    })
    .map((product) => {
      const prices = product.prices.map((x) => ({ ...x, unitAmount: x.unitAmount ?? 0 }));
      const price = prices.filter((x) => x.id === product.defaultPriceId)[0] ?? prices[0];

      return {
        ...product,
        price,
        prices,
      };
    })
    .sort((a, b) => (a.price?.unitAmount ?? 0) - (b.price?.unitAmount ?? 0));
};

export type SubscriptionPlan = Awaited<ReturnType<typeof getPlans>>[number];

export const getUserSubscription = async ({
  userId,
  buzzType,
}: GetUserSubscriptionInput & { buzzType?: string }) => {
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

  if (
    !subscription ||
    ['canceled', 'incomplete_expired', 'past_due', 'unpaid'].some((s) => s === subscription.status)
  )
    return null;

  const productMeta = subscription.product.metadata as SubscriptionProductMetadata;

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
      const productMeta = subscription.product.metadata as SubscriptionProductMetadata;
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
    const meta = p.metadata as SubscriptionProductMetadata;
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
