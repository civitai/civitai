import type { TransactionNotification } from '@paddle/paddle-node-sdk';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import {
  GetUserSubscriptionInput,
  SubscriptionMetadata,
  SubscriptionProductMetadata,
} from '~/server/schema/subscriptions.schema';
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';

// const baseUrl = getBaseUrl();
// const log = createLogger('subscriptions', 'blue');

export const getPlans = async ({
  paymentProvider = PaymentProvider.Stripe,
  includeFree = false,
  includeInactive = false,
}: {
  paymentProvider?: PaymentProvider;
  includeFree?: boolean;
  includeInactive?: boolean;
}) => {
  const products = await dbRead.product.findMany({
    where: {
      provider: paymentProvider,
      active: includeInactive ? undefined : true,
      prices: { some: { type: 'recurring', active: true } },
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
        },
      },
    },
  });

  // Only show the default price for a subscription product
  return products
    .filter(({ metadata }) => {
      return env.TIER_METADATA_KEY
        ? !!(metadata as any)?.[env.TIER_METADATA_KEY] &&
            ((metadata as any)?.[env.TIER_METADATA_KEY] !== 'free' || includeFree)
        : true;
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

export const getUserSubscription = async ({ userId }: GetUserSubscriptionInput) => {
  const subscription = await dbRead.customerSubscription.findUnique({
    where: { userId },
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
      product: {
        select: {
          id: true,
          name: true,
          description: true,
          metadata: true,
          provider: true,
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

  if (!subscription || subscription.status === 'canceled') return null;

  const productMeta = subscription.product.metadata as SubscriptionProductMetadata;

  const subscriptionMeta = (subscription.metadata ?? {}) as SubscriptionMetadata;
  if (subscriptionMeta.renewalEmailSent) {
    // Makes it so that we don't consider this a "subscribed" user.
    return null;
  }

  return {
    ...subscription,
    price: { ...subscription.price, unitAmount: subscription.price.unitAmount ?? 0 },
    isBadState: ['incomplete', 'incomplete_expired', 'past_due', 'unpaid'].includes(
      subscription.status
    ),
    tier: productMeta?.[env.TIER_METADATA_KEY] ?? 'free',
    productMeta,
  };
};
export type UserSubscription = Awaited<ReturnType<typeof getUserSubscription>>;

export const paddleTransactionContainsSubscriptionItem = async (data: TransactionNotification) => {
  const priceIds = data.items.map((i) => i.price?.id).filter(isDefined);

  if (priceIds.length === 0) {
    return false;
  }

  const products = await dbRead.product.findMany({
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
