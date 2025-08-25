import type {
  Adjustment,
  AdjustmentAction,
  Discount,
  IEventName,
  PriceNotification,
  ProductNotification,
  SubscriptionNotification,
  TransactionNotification,
} from '@paddle/paddle-node-sdk';
import { ApiError, SubscriptionItemNotification } from '@paddle/paddle-node-sdk';
import dayjs from '~/shared/utils/dayjs';
import { env } from '~/env/server';
import { constants, HOLIDAY_PROMO_VALUE, specialCosmeticRewards } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  cancelPaddleSubscription,
  createBuzzTransaction as createPaddleBuzzTransaction,
  createOneTimeProductPurchaseTransaction,
  getCustomerLatestTransaction,
  getOrCreateCustomer,
  getPaddleAdjustments,
  getPaddleCustomerSubscriptions,
  getPaddleSubscription,
  subscriptionBuzzOneTimeCharge,
  updatePaddleSubscription,
  createAnnualSubscriptionDiscount,
} from '~/server/paddle/client';
import { TransactionType } from '~/server/schema/buzz.schema';
import type {
  GetPaddleAdjustmentsSchema,
  TransactionCreateInput,
  TransactionMetadataSchema,
  TransactionWithSubscriptionCreateInput,
  UpdateSubscriptionInputSchema,
} from '~/server/schema/paddle.schema';
import type {
  SubscriptionMetadata,
  SubscriptionProductMetadata,
} from '~/server/schema/subscriptions.schema';
import { subscriptionProductMetadataSchema } from '~/server/schema/subscriptions.schema';
import { createBuzzTransaction, getMultipliersForUser } from '~/server/services/buzz.service';
import { grantCosmetics } from '~/server/services/cosmetic.service';
import { getPlans } from '~/server/services/subscriptions.service';
import { getOrCreateVault } from '~/server/services/vault.service';
import { getBuzzBulkMultiplier } from '~/server/utils/buzz-helpers';
import {
  handleLogError,
  sleep,
  throwBadRequestError,
  throwNotFoundError,
  withRetries,
} from '~/server/utils/errorHandling';
import { invalidateSession } from '~/server/utils/session-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { Currency, PaymentProvider } from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';
import { numberWithCommas } from '~/utils/number-helpers';

const baseUrl = getBaseUrl();
const log = createLogger('paddle', 'yellow');

export const createCustomer = async ({ id, email }: { id: number; email: string }) => {
  const user = await dbWrite.user.findUnique({ where: { id }, select: { paddleCustomerId: true } });
  if (!user?.paddleCustomerId) {
    const customer = await getOrCreateCustomer({ email, userId: id });

    await dbWrite.user.update({ where: { id }, data: { paddleCustomerId: customer.id } });
    await invalidateSession(id);

    return customer.id;
  } else {
    return user.paddleCustomerId;
  }
};

const getBuzzTransactionMetadata = ({
  unitAmount,
  userId,
}: {
  unitAmount: number;
  userId: number;
}): TransactionMetadataSchema => {
  return {
    type: 'buzzPurchase',
    unitAmount: unitAmount,
    buzzAmount: unitAmount * 10, // 10x
    userId,
  };
};

export const createBuzzPurchaseTransaction = async ({
  unitAmount,
  currency = Currency.USD,
  customerId,
  user,
}: TransactionCreateInput & {
  user: { id: number; email: string };
  customerId?: string;
}) => {
  if (!user?.email && !customerId) {
    throw throwBadRequestError('Email is required to create a transaction');
  }

  if (!customerId) {
    customerId = await createCustomer(user);
  }

  if (!customerId) {
    throw throwBadRequestError('We were unable to get or create a paddle customer');
  }

  const subscription = await dbWrite.customerSubscription.findUnique({
    where: {
      userId: user.id,
      status: {
        in: ['active', 'trialing'],
      },
    },
    select: { id: true },
  });
  const products = await dbWrite.product.findMany({
    where: {
      provider: PaymentProvider.Paddle,
    },
    include: {
      prices: {
        where: {
          active: true,
        },
      },
    },
  });

  const productsToIncludeWithTransactions = products.filter((p) => {
    const parsedMeta = subscriptionProductMetadataSchema.safeParse(p.metadata);
    return parsedMeta.success && parsedMeta.data.includeWithTransaction && p.prices.length > 0;
  });

  const transaction = await createPaddleBuzzTransaction({
    customerId,
    unitAmount,
    buzzAmount: unitAmount * 10, // 10x
    currency,
    metadata: getBuzzTransactionMetadata({ unitAmount, userId: user.id }),
    // Avoid adding the free tier. Paddle seems to have a new way to handle these.
  });

  return {
    transactionId: transaction.id,
  };
};

export const getBuzzPurchaseItem = (transaction: TransactionNotification) => {
  return transaction.items.find((i) => {
    const itemMeta = i.price?.customData as TransactionMetadataSchema;
    return itemMeta?.type === 'buzzPurchase';
  });
};

export const processCompleteBuzzTransaction = async (
  transaction: TransactionNotification,
  buzzTransactionExtras?: MixedObject
) => {
  const items = transaction.items;
  const buzzItem = items.find((i) => {
    const itemMeta = i.price?.customData as TransactionMetadataSchema;
    return itemMeta?.type === 'buzzPurchase';
  });

  if (!buzzItem) {
    throw throwBadRequestError('Could not find Buzz item in transaction');
  }

  const meta = buzzItem.price?.customData as TransactionMetadataSchema;

  if (!meta || meta?.type !== 'buzzPurchase') {
    throw throwBadRequestError('Only use this method to process Buzz purchases.');
  }

  if (meta.buzzTransactionId) {
    // Already processed.
    return;
  }

  const userId = meta.user_id ?? meta.userId;
  const { purchasesMultiplier } = await getMultipliersForUser(userId);
  const amount = meta.buzz_amount ?? meta.buzzAmount;

  const { blueBuzzAdded, totalYellowBuzz, bulkBuzzMultiplier } = getBuzzBulkMultiplier({
    buzzAmount: amount,
    purchasesMultiplier,
  });

  // Pay the user:
  await createBuzzTransaction({
    amount: totalYellowBuzz,
    fromAccountId: 0,
    toAccountId: userId,
    externalTransactionId: transaction.id,
    type: TransactionType.Purchase,
    description: `Purchase of ${amount} Buzz. ${
      purchasesMultiplier && purchasesMultiplier > 1 ? 'Multiplier applied due to membership. ' : ''
    }A total of ${numberWithCommas(totalYellowBuzz)} Buzz was added to your account.`,
    details: {
      paddleTransactionId: transaction.id,
      ...buzzTransactionExtras,
    },
  });

  if (blueBuzzAdded > 0) {
    await createBuzzTransaction({
      amount: blueBuzzAdded,
      fromAccountId: 0,
      toAccountId: userId,
      toAccountType: 'generation',
      externalTransactionId: `${transaction.id}-bulk-reward`,
      type: TransactionType.Purchase,
      description: `A total of ${numberWithCommas(
        blueBuzzAdded
      )} Blue Buzz was added to your account for Bulk purchase.`,
      details: {
        paddleTransactionId: transaction.id,
        ...buzzTransactionExtras,
      },
    });
  }

  if (bulkBuzzMultiplier > 1) {
    // TODO: Grant cosmetic :shrugh:
    const cosmeticIds = specialCosmeticRewards.bulkBuzzRewards;
    await grantCosmetics({
      userId,
      cosmeticIds,
    });
  }
};

export const purchaseBuzzWithSubscription = async ({
  unitAmount,
  currency = Currency.USD,
  userId,
}: TransactionWithSubscriptionCreateInput & {
  userId: number;
}) => {
  const subscription = await dbWrite.customerSubscription.findUnique({
    where: {
      userId,
      status: {
        in: ['active', 'trialing'],
      },
    },
    select: { id: true },
  });

  if (!subscription) {
    throw throwBadRequestError('No active subscription found');
  }

  const paddleSubscription = await getPaddleSubscription({ subscriptionId: subscription.id });

  if (!paddleSubscription) {
    throw throwBadRequestError('No active subscription found on Paddle');
  }

  await subscriptionBuzzOneTimeCharge({
    subscriptionId: subscription.id,
    unitAmount,
    buzzAmount: unitAmount * 10, // 10x
    currency,
    metadata: getBuzzTransactionMetadata({ unitAmount, userId }),
  });

  const transaction = await getCustomerLatestTransaction({
    customerId: paddleSubscription.customerId,
  });

  return transaction?.id;
};

export const upsertProductRecord = async (product: ProductNotification) => {
  const productData = {
    id: product.id,
    active: product.status === 'active',
    name: product.name,
    description: product.description ?? null,
    metadata: product.customData ?? undefined,
    // Paddle doesn't have a concept of default price in the same way as Stripe.
    // We backfill when we receive a price with default metadata.
    defaultPriceId: undefined,
    provider: PaymentProvider.Paddle,
  };

  await dbWrite.product.upsert({
    where: { id: product.id },
    update: productData,
    create: {
      ...productData,
      metadata: productData.metadata ?? {},
    },
  });

  return productData;
};

export const upsertPriceRecord = async (price: PriceNotification) => {
  const priceMeta = (price.customData ?? {}) as { default?: boolean };

  const product = await dbWrite.product.findFirst({
    where: { id: price.productId },
  });

  if (!product) {
    return; // Don't add anything
  }

  const priceData = {
    id: price.id,
    productId: price.productId,
    active: price.status === 'active',
    currency: price.unitPrice.currencyCode,
    description: price.description ?? undefined,
    type: price.billingCycle ? 'recurring' : 'one_time',
    unitAmount: parseInt(price.unitPrice.amount, 10),
    interval: price.billingCycle?.interval,
    intervalCount: price.billingCycle?.frequency,
    metadata: price.customData ?? undefined,
    provider: PaymentProvider.Paddle,
  };

  await dbWrite.price.upsert({
    where: { id: price.id },
    update: priceData,
    create: {
      ...priceData,
      metadata: priceData.metadata ?? {},
    },
  });

  if (priceMeta.default) {
    // Update the product
    await dbWrite.product.update({
      where: { id: price.productId },
      data: { defaultPriceId: price.id },
    });
  }

  return priceData;
};

export const upsertSubscription = async (
  subscriptionNotification: Omit<SubscriptionNotification, 'transactionId'>,
  eventDate: Date,
  eventName: IEventName
) => {
  log('upsertSubscription :: Event:', eventName);
  const isUpdatingSubscription = eventName === 'subscription.updated';
  const isCreatingSubscription = eventName === 'subscription.activated';
  const isSchedulingCancelation = subscriptionNotification.scheduledChange?.action === 'cancel';
  const isCancelingSubscription = eventName === 'subscription.canceled' || isSchedulingCancelation;

  const subscriptionProducts = await getPlans({
    paymentProvider: PaymentProvider.Paddle,
    includeFree: true, // User might be activating a free membership.
    includeInactive: true,
  });

  const mainSubscriptionItem = subscriptionNotification.items.find((i) => {
    return i.status === 'active' && subscriptionProducts.some((p) => p.id === i.price?.productId);
  });

  if (!mainSubscriptionItem) {
    log('upsertSubscription :: No active subscription product found');
    throw throwNotFoundError('No active subscription product found');
  }

  const subscriptionItemProduct = subscriptionProducts.find(
    (p) => p.id === mainSubscriptionItem.price?.productId
  );

  log('upsertSubscription :: main subscription item:', mainSubscriptionItem);

  if (isUpdatingSubscription) {
    // We need to wait a bit to avoid race conditions
    log('upsertSubscription :: waiting a few ms..');
    await sleep(500);
  }

  const user = await dbWrite.user.findFirst({
    where: { paddleCustomerId: subscriptionNotification.customerId },
    select: {
      id: true,
      paddleCustomerId: true,
    },
  });

  if (!user)
    throw throwNotFoundError(
      `User with customerId: ${subscriptionNotification.customerId} not found`
    );

  const userSubscription = await dbWrite.customerSubscription.findFirst({
    // I rather we trust this than the subscriptionId on the user.
    where: { userId: user.id },
    select: {
      id: true,
      status: true,
      metadata: true,
      currentPeriodEnd: true,
      product: { select: { provider: true } },
    },
  });

  const userHasSubscription = !!userSubscription;
  const isSameSubscriptionItem = userSubscription?.id === subscriptionNotification.id;

  const startingNewSubscription =
    (isCreatingSubscription || userSubscription?.product?.provider !== PaymentProvider.Paddle) &&
    userHasSubscription &&
    !isSameSubscriptionItem;

  if (
    userSubscription &&
    !isSameSubscriptionItem &&
    (subscriptionItemProduct?.metadata as SubscriptionProductMetadata)?.tier === 'free' &&
    userSubscription.status === 'active'
  ) {
    // This is a free tier subscription, we should cancel the old one.
    log(
      'upsertSubscription :: Free tier subscription, ignoring this event since user has a sub already'
    );

    return;
  }

  if (subscriptionNotification.status === 'canceled') {
    // @justin - Disabling this for now since Paddle is immediately canceling...
    // immediate cancel:
    // log('upsertSubscription :: Subscription canceled immediately');
    // await dbWrite.customerSubscription.update({
    //   where: { userId: user.id },
    //   data: {
    //     status: 'canceled',
    //     canceledAt: new Date(),
    //     cancelAtPeriodEnd: false,
    //   },
    // });
    // @justin - Cancel at period end for now...
    await dbWrite.customerSubscription.update({
      where: { userId: user.id },
      data: {
        status: userSubscription?.status ?? 'canceled',
        cancelAt: userSubscription?.currentPeriodEnd ?? new Date(),
        canceledAt: userSubscription?.currentPeriodEnd ?? new Date(),
        cancelAtPeriodEnd: true,
      },
    });
    await getMultipliersForUser(user.id, true);
    await invalidateSession(user.id);
    await dbWrite.vault.update({
      where: { userId: user.id },
      data: {
        storageKb: 0, // Reset storage to 0
      },
    });

    return;
  }

  if (startingNewSubscription) {
    log('upsertSubscription :: Subscription id changed, deleting old subscription');
    if (userSubscription) {
      await dbWrite.customerSubscription.delete({ where: { userId: user.id } });
    }
    const subscriptionMeta = (userSubscription?.metadata ?? {}) as SubscriptionMetadata;
    if (subscriptionMeta.renewalEmailSent && !!subscriptionMeta.renewalBonus) {
      // This is a migration that we reached out to:
      await withRetries(async () => {
        await createBuzzTransaction({
          fromAccountId: 0,
          toAccountId: user.id,
          type: TransactionType.Purchase,
          amount: subscriptionMeta.renewalBonus as number,
          description: 'Thank you for your continued support! Here is a bonus for you.',
          externalTransactionId: `renewalBonus:${user.id}`,
        });
      });
    }
  } else if (userHasSubscription && isCreatingSubscription) {
    log('upsertSubscription :: Subscription already up to date');
    return;
  }

  const data = {
    id: subscriptionNotification.id,
    userId: user.id,
    metadata: subscriptionNotification?.customData ?? {},
    status: subscriptionNotification.status,
    // as far as I can tell, there are never multiple items in this array
    priceId: mainSubscriptionItem.price?.id as string,
    productId: mainSubscriptionItem.price?.productId as string,
    cancelAtPeriodEnd: isCancelingSubscription ? true : false,
    cancelAt: isSchedulingCancelation
      ? new Date(subscriptionNotification.scheduledChange?.effectiveAt)
      : null,
    canceledAt: isSchedulingCancelation ? new Date() : null,
    currentPeriodStart: subscriptionNotification.currentBillingPeriod?.startsAt
      ? new Date(subscriptionNotification.currentBillingPeriod?.startsAt)
      : undefined,
    currentPeriodEnd: subscriptionNotification.currentBillingPeriod?.endsAt
      ? new Date(subscriptionNotification.currentBillingPeriod?.endsAt)
      : undefined,
    createdAt: new Date(subscriptionNotification.createdAt),
    endedAt: null,
    updatedAt: eventDate,
  };

  await dbWrite.$transaction([
    dbWrite.customerSubscription.upsert({
      where: { id: data.id },
      update: data,
      create: {
        ...data,
        currentPeriodStart: new Date(
          subscriptionNotification.currentBillingPeriod?.startsAt as string
        ),
        currentPeriodEnd: new Date(subscriptionNotification.currentBillingPeriod?.endsAt as string),
      },
    }),
  ]);

  if (userSubscription?.status !== data.status && ['active', 'canceled'].includes(data.status)) {
    // TODO: track with clickhouse
    // await playfab.trackEvent(user.id, {
    //   eventName: data.status === 'active' ? 'user_start_membership' : 'user_cancel_membership',
    //   productId: data.productId,
    // });
  }

  const userVault = await dbWrite.vault.findFirst({
    where: { userId: user.id },
  });

  // Get Stripe details on the vault:
  const product = await dbWrite.product.findFirst({
    where: { id: data.productId },
  });

  if (data.status === 'active') {
    const parsedMeta = subscriptionProductMetadataSchema.safeParse(product?.metadata);
    const vault = userVault ? userVault : await getOrCreateVault({ userId: user.id });
    if (parsedMeta.success && vault.storageKb !== parsedMeta.data.vaultSizeKb) {
      await dbWrite.vault.update({
        where: { userId: vault.userId },
        data: {
          storageKb: parsedMeta.data.vaultSizeKb,
        },
      });
    }
  }

  // Special check for special cosmetics
  if (Object.values(specialCosmeticRewards.annualRewards).some((r) => r.length > 0)) {
    const price = await dbWrite.price.findUnique({
      where: { id: data.priceId },
      select: {
        id: true,
        interval: true,
        product: {
          select: {
            id: true,
            metadata: true,
          },
        },
      },
    });

    if (price && price.interval === 'year') {
      // Grant special cosmetics:
      const productMeta = price.product.metadata as SubscriptionProductMetadata;

      const keys = Object.keys(specialCosmeticRewards.annualRewards).filter((k) => {
        return (
          constants.memberships.tierOrder.indexOf(k as typeof productMeta.tier) <=
          constants.memberships.tierOrder.indexOf(productMeta.tier)
        );
      });

      const cosmeticIds = keys
        .map((k) => {
          return specialCosmeticRewards.annualRewards[
            k as keyof typeof specialCosmeticRewards.annualRewards
          ];
        })
        .flat();

      await grantCosmetics({
        userId: user.id,
        cosmeticIds: cosmeticIds,
      });
    }
  }

  await invalidateSession(user.id);
  await getMultipliersForUser(user.id, true);
};

export const manageSubscriptionTransactionComplete = async (
  transactionNotification: TransactionNotification,
  buzzTransactionExtras?: MixedObject
) => {
  if (!transactionNotification.subscriptionId) {
    return;
  }

  if (
    transactionNotification.details?.totals?.total === '0' &&
    transactionNotification.details?.totals?.discount === '0'
  ) {
    // Free trial or payment method update.
    return;
  }
  // Check if user exists and has a customerId
  // Use write db to avoid replication lag between webhook requests
  const user = await dbWrite.user.findUniqueOrThrow({
    where: { paddleCustomerId: transactionNotification.customerId as string },
    select: { id: true, paddleCustomerId: true },
  });

  const purchases = transactionNotification.items.map((data) => ({
    userId: user.id,
    priceId: data.price?.id,
    productId: data.price?.productId as string | undefined,
    status: 'paid',
  }));

  await dbWrite.purchase.createMany({ data: purchases });

  const plans = await getPlans({ paymentProvider: PaymentProvider.Paddle, includeInactive: true });

  // Don't check for subscription active because there is a chance it hasn't been updated yet
  const paidPlans = plans.filter((p) => {
    return transactionNotification.items.some((i) => i.price?.productId === p.id);
  });

  if (paidPlans.length > 0) {
    await withRetries(() => {
      return Promise.all(
        paidPlans.map(async (p) => {
          const meta = p.metadata as SubscriptionProductMetadata;
          const externalTransactionId = `transactionId:${transactionNotification.id}-product:${p.id}`;
          await createBuzzTransaction({
            fromAccountId: 0,
            toAccountId: user.id,
            type: TransactionType.Purchase,
            externalTransactionId,
            amount: meta.monthlyBuzz ?? 3000, // assume a min of 3000.
            description: `Membership bonus`,
            details: {
              paddleTransactionId: transactionNotification.id,
              productId: p.id,
              ...buzzTransactionExtras,
            },
          });

          const date = dayjs().subtract(12, 'hours'); // Subtract 12 hrs to ensure that we cover for all timezones.. Max UTC is -12.
          if (date.month() === 11 && (meta.monthlyBuzz ?? 3000) > 0) {
            await createBuzzTransaction({
              fromAccountId: 0,
              toAccountId: user.id,
              type: TransactionType.Purchase,
              externalTransactionId: `christmas-2024:${externalTransactionId}`,
              amount: Math.floor((meta.monthlyBuzz ?? 3000) * HOLIDAY_PROMO_VALUE), // assume a min of 3000.
              description: `20% additional Blue Buzz for being a member! Happy Holidays from Civitai`,
              toAccountType: 'generation',
              details: {
                paddleTransactionId: transactionNotification.id,
                productId: p.id,
                ...buzzTransactionExtras,
              },
            });
          }
        })
      );
    }).catch(handleLogError);
  }
};

export const cancelSubscriptionPlan = async ({ userId }: { userId: number }) => {
  const subscription = await dbWrite.customerSubscription.findFirst({
    select: {
      id: true,
      product: {
        select: {
          id: true,
          metadata: true,
        },
      },
    },
    where: {
      userId,
      status: {
        in: ['active', 'trialing'],
      },
      product: {
        provider: PaymentProvider.Paddle,
      },
    },
  });

  if (!subscription) {
    // Attempt to cancel the subscription on Paddle
    const user = await dbWrite.user.findUnique({ where: { id: userId } });

    if (!user?.paddleCustomerId) {
      return;
    }

    const customerSubscriptions = await getPaddleCustomerSubscriptions({
      customerId: user?.paddleCustomerId,
    });

    if (customerSubscriptions.length === 0) {
      throw throwNotFoundError('No active subscription found');
    }

    await Promise.all(
      customerSubscriptions.map((sub) => cancelPaddleSubscription(sub.id, 'immediately'))
    );

    return;
  }

  const paddleSubscription = await getPaddleSubscription({ subscriptionId: subscription.id });

  if (!paddleSubscription) {
    throw throwNotFoundError(
      'This subscription does not seem active on Paddle. Please contact support.'
    );
  }

  const meta = subscription.product.metadata as SubscriptionProductMetadata;
  const isFreeTier = env.TIER_METADATA_KEY ? meta[env.TIER_METADATA_KEY] === 'free' : false;

  try {
    await cancelPaddleSubscription(
      subscription.id,
      isFreeTier ? 'immediately' : 'next_billing_period'
    );

    await sleep(500); // Waits for the webhook to update the subscription. Might be wishful thinking.

    await invalidateSession(userId);
    await getMultipliersForUser(userId, true);

    return true;
  } catch (e) {
    return new Error('Failed to cancel subscription');
  }
};

export const updateSubscriptionPlan = async ({
  priceId,
  userId,
}: {
  userId: number;
} & UpdateSubscriptionInputSchema) => {
  const subscription = await dbWrite.customerSubscription.findFirst({
    include: {
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
      product: {
        select: {
          id: true,
          metadata: true,
          provider: true,
        },
      },
    },
    where: {
      userId,
      status: {
        in: ['active', 'trialing'],
      },
      product: {
        provider: PaymentProvider.Paddle,
      },
    },
  });

  if (!subscription) {
    throw throwNotFoundError('No active subscription found');
  }

  const targetPrice = await dbWrite.price.findUnique({
    where: { id: priceId, active: true },
    select: {
      id: true,
      unitAmount: true,
      interval: true,
      intervalCount: true,
      currency: true,
      active: true,
      product: {
        select: {
          id: true,
          metadata: true,
          provider: true,
        },
      },
    },
  });

  if (!targetPrice) {
    throw throwNotFoundError('The product you are trying to update to does not exist');
  }

  if (targetPrice.product.provider !== PaymentProvider.Paddle) {
    throw throwBadRequestError('The product you are trying to update to is not managed by Paddle');
  }

  if (subscription.product.provider !== PaymentProvider.Paddle) {
    throw throwBadRequestError('The product you are trying to update to is not managed by Paddle');
  }

  const paddleSubscription = await getPaddleSubscription({ subscriptionId: subscription.id });

  if (!paddleSubscription) {
    throw throwNotFoundError('No active subscription found on Paddle');
  }

  try {
    if (
      subscription.priceId === priceId &&
      paddleSubscription.scheduledChange?.action === 'cancel'
    ) {
      // Treat as resume subscription:
      await updatePaddleSubscription({
        subscriptionId: subscription.id,
        scheduledChange: null,
      });
    } else if (subscription.priceId !== priceId) {
      try {
        await updatePaddleSubscription({
          subscriptionId: subscription.id,
          items: [
            {
              priceId,
              quantity: 1,
            },
          ],
          prorationBillingMode: 'do_not_bill',
        });

        let discount: Discount | null = null;
        // Will apply for both downgrades and upgrades. This is basically a pro-ration based off on
        // the number of payments BUZZ we've made to this user
        if (subscription?.price.interval === 'year' && targetPrice?.interval === 'year') {
          const monthsSinceMembership =
            dayjs().diff(subscription.currentPeriodStart ?? subscription.createdAt, 'month') + 1; // Must always assume we've given at least 1 payment.

          const discountAmount = Math.floor(
            monthsSinceMembership >= 12
              ? 0
              : (monthsSinceMembership / 12) * (subscription.price.unitAmount ?? 0)
          );

          discount = await createAnnualSubscriptionDiscount({
            amount: discountAmount.toString(),
            currency: targetPrice?.currency,
            userId: userId,
          });
        }

        // For whatever random reason in the world, Paddle doesn't update the next billed at date
        // automatically when you change the subscription. So we do it manually.
        const nextBilledAt = dayjs().add(30, 'minute').add(20, 'second').toISOString();

        await updatePaddleSubscription({
          subscriptionId: subscription.id,
          nextBilledAt: nextBilledAt,
          prorationBillingMode: 'prorated_immediately',
          customData: {
            ...paddleSubscription.customData,
            originalNextBilledAt: paddleSubscription?.nextBilledAt,
          },
          discount: discount
            ? {
                id: discount.id,
                effectiveFrom: 'next_billing_period',
              }
            : undefined,
        });
      } catch (e) {
        logToAxiom({
          subscriptionId: paddleSubscription.id,
          type: 'error',
          message: 'Failed to update subscription',
          userId,
          priceId,
          error: e,
          stack: (e as Error)?.stack,
        });

        throw e;
      }
    }

    await sleep(500); // Waits for the webhook to update the subscription. Might be wishful thinking.

    await invalidateSession(userId);
    await getMultipliersForUser(userId, true);

    return true;
  } catch (e) {
    if (e instanceof ApiError) {
      throw new Error((e as ApiError).detail);
    }
  }
};

export const refreshSubscription = async ({ userId }: { userId: number }) => {
  return true; // Disable refreshing from Paddle since they're dead

  // let customerId = '';
  // const user = await dbWrite.user.findUnique({
  //   where: { id: userId },
  //   select: { paddleCustomerId: true, email: true, id: true },
  // });

  // const customerSubscription = await dbWrite.customerSubscription.findFirst({
  //   where: {
  //     userId,
  //     status: {
  //       in: ['active', 'trialing'],
  //     },
  //   },
  // });

  // if (!user?.email && !user?.paddleCustomerId) {
  //   throw throwBadRequestError('Email is required to create a customer');
  // }

  // if (!user?.paddleCustomerId) {
  //   customerId = await createCustomer({ id: userId, email: user.email as string });
  // } else {
  //   customerId = user.paddleCustomerId;
  // }

  // const subscriptions = await getPaddleCustomerSubscriptions({ customerId });

  // if (subscriptions.length === 0) {
  //   throwBadRequestError('No active subscriptions found on Paddle');
  // }

  // const subscription = subscriptions[0];

  // if (customerSubscription && customerSubscription.id !== subscription.id) {
  //   // This is a different subscription, we should update the user.
  //   await dbWrite.customerSubscription.delete({ where: { id: customerSubscription.id } });
  // }
  // try {
  //   // This should trigger an update...
  //   await updatePaddleSubscription({
  //     subscriptionId: subscription.id,
  //     customData: {
  //       ...subscription.customData,
  //       refreshed: new Date().toISOString(),
  //     },
  //   });

  //   await sleep(500); // Waits for the webhook to update the subscription. Might be wishful thinking.

  //   await invalidateSession(userId);
  //   await getMultipliersForUser(userId, true);

  //   return true;
  // } catch (error) {
  //   if (error instanceof ApiError) {
  //     // Check if they are ok errors
  //     const apiError = error as ApiError;
  //     if (
  //       apiError.code === 'subscription_locked_renewal' ||
  //       apiError.code === 'subscription_locked_pending_changes'
  //     ) {
  //       // Not a bad error, we can ignore this.
  //       return true;
  //     }
  //   }

  //   throw error;
  // }
};

export const cancelAllPaddleSubscriptions = async ({ customerId }: { customerId: string }) => {
  const subs = await getPaddleCustomerSubscriptions({ customerId });
  const subsToCancel = subs.filter((sub) => sub.status === 'active');
  const cancelPromises = subsToCancel.map((sub) => cancelPaddleSubscription(sub.id, 'immediately'));
  return Promise.all(cancelPromises);
};

export const getAdjustmentsInfinite = async ({
  limit = 50,
  cursor,
  customerId,
  subscriptionId,
  transactionId,
  action,
}: GetPaddleAdjustmentsSchema) => {
  const data = await getPaddleAdjustments({
    after: cursor,
    perPage: limit + 1,
    // Paddle is picky about empty arrays.....
    customerId: customerId?.length ? customerId : undefined,
    subscriptionId: subscriptionId?.length ? subscriptionId : undefined,
    transactionId: transactionId?.length ? transactionId : undefined,
    action: action ? (action as AdjustmentAction) : undefined,
  });

  const hasMore = data.length > limit;
  let nextItem: Adjustment | undefined;
  if (hasMore) {
    data.pop();
    nextItem = data[data.length - 1];
  }

  return {
    items: data,
    nextCursor: nextItem?.id,
  };
};

export const createOneTimePurchaseTransaction = async ({
  productId,
  userId,
}: {
  productId: string;
  userId: number;
}) => {
  const product = await dbWrite.product.findUnique({
    where: { id: productId, provider: PaymentProvider.Paddle },
    select: {
      id: true,
      defaultPriceId: true,
      prices: { where: { active: true, type: 'one_time' } },
    },
  });

  if (!product) {
    throw throwNotFoundError('Product not found');
  }

  if (!product.prices.length) {
    throw throwBadRequestError('Product does not have a one-time price');
  }

  const price = product.prices.find((p) => p.id === product.defaultPriceId) ?? product.prices[0];

  if (!price) {
    throw throwNotFoundError('Price not found');
  }

  const user = await dbWrite.user.findFirst({
    where: { id: userId },
    select: { paddleCustomerId: true, email: true },
  });

  if (!user) {
    throw throwNotFoundError('User not found');
  }

  let customerId = user?.paddleCustomerId;

  if (!user?.paddleCustomerId) {
    customerId = await createCustomer({ id: userId, email: user.email as string });
  }

  const paddleTransaction = await createOneTimeProductPurchaseTransaction({
    customerId: customerId as string,
    priceId: price.id,
  });

  return paddleTransaction.id;
};
