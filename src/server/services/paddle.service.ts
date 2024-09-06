import { Currency, PaymentProvider } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  handleLogError,
  sleep,
  throwBadRequestError,
  throwNotFoundError,
  withRetries,
} from '~/server/utils/errorHandling';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { createLogger } from '~/utils/logging';
import { invalidateSession } from '~/server/utils/session-helpers';
import {
  createBuzzTransaction as createPaddleBuzzTransaction,
  getCustomerLatestTransaction,
  getOrCreateCustomer,
  getPaddleSubscription,
  subscriptionBuzzOneTimeCharge,
  updatePaddleSubscription,
  // updateTransaction,
} from '~/server/paddle/client';
import {
  TransactionCreateInput,
  TransactionMetadataSchema,
  TransactionWithSubscriptionCreateInput,
  UpdateSubscriptionInputSchema,
} from '~/server/schema/paddle.schema';
import {
  Transaction,
  ProductNotification,
  PriceNotification,
  EventName,
  SubscriptionNotification,
  TransactionNotification,
} from '@paddle/paddle-node-sdk';
import { createBuzzTransaction, getMultipliersForUser } from '~/server/services/buzz.service';
import { TransactionType } from '~/server/schema/buzz.schema';
import { getPlans } from '~/server/services/subscriptions.service';
import { playfab } from '~/server/playfab/client';
import {
  SubscriptionProductMetadata,
  subscriptionProductMetadataSchema,
} from '~/server/schema/subscriptions.schema';
import { getOrCreateVault } from '~/server/services/vault.service';
import { env } from 'node:process';

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

  const subscription = await dbRead.customerSubscription.findUnique({
    where: {
      userId: user.id,
      status: {
        in: ['active', 'trialing'],
      },
    },
    select: { id: true },
  });
  const products = await dbRead.product.findMany({
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
    // Only included if the user has no subscriptions so we can tie them up.
    includedItems: !subscription
      ? productsToIncludeWithTransactions.map((p) => ({
          priceId: p.prices[0].id,
          quantity: 1,
        }))
      : undefined,
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
  transaction: Transaction,
  buzzTransactionExtras?: MixedObject
) => {
  const items = transaction.items;
  const buzzItem = items.find((i) => {
    const itemMeta = i.price?.customData as TransactionMetadataSchema;
    return itemMeta?.type === 'buzzPurchase';
  });

  if (!buzzItem) {
    throw throwBadRequestError('Could not find buzz item in transaction');
  }

  const meta = buzzItem.price?.customData as TransactionMetadataSchema;

  if (!meta || meta?.type !== 'buzzPurchase') {
    throw throwBadRequestError('Only use this method to process buzz purchases.');
  }

  if (meta.buzzTransactionId) {
    // Already processed.
    return;
  }

  const userId = meta.user_id ?? meta.userId;
  const { purchasesMultiplier } = await getMultipliersForUser(userId);
  const amount = meta.buzz_amount ?? meta.buzzAmount;
  const buzzAmount = Math.ceil(amount * (purchasesMultiplier ?? 1));

  // Pay the user:
  const buzzTransaction = await createBuzzTransaction({
    amount: buzzAmount,
    fromAccountId: 0,
    toAccountId: userId,
    externalTransactionId: transaction.id,
    type: TransactionType.Purchase,
    description: `Purchase of ${amount} buzz. ${
      purchasesMultiplier && purchasesMultiplier > 1 ? 'Multiplier applied due to membership. ' : ''
    }A total of ${buzzAmount} buzz was added to your account.`,
    details: {
      paddleTransactionId: transaction.id,
      ...buzzTransactionExtras,
    },
  });
};

export const purchaseBuzzWithSubscription = async ({
  unitAmount,
  currency = Currency.USD,
  userId,
}: TransactionWithSubscriptionCreateInput & {
  userId: number;
}) => {
  const subscription = await dbRead.customerSubscription.findUnique({
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

  const product = await dbRead.product.findFirst({
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
  subscriptionNotification: SubscriptionNotification,
  eventDate: Date,
  eventName: EventName
) => {
  log('upsertSubscription :: Event:', eventName);
  const isUpdatingSubscription = eventName === EventName.SubscriptionUpdated;
  const isCreatingSubscription = eventName === EventName.SubscriptionActivated;
  const isCancelingSubscription = eventName === EventName.SubscriptionCanceled;

  const subscriptionProducts = await getPlans({
    paymentProvider: PaymentProvider.Paddle,
    includeFree: true, // User might be activating a free membership.
  });

  const mainSubscriptionItem = subscriptionNotification.items.find((i) => {
    return i.status === 'active' && subscriptionProducts.some((p) => p.id === i.price?.productId);
  });

  if (!mainSubscriptionItem) {
    log('upsertSubscription :: No active subscription product found');
    throw throwNotFoundError('No active subscription product found');
  }

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

  const userSubscription = await dbRead.customerSubscription.findFirst({
    // I rather we trust this than the subscriptionId on the user.
    where: { userId: user.id },
    select: { id: true, status: true },
  });

  const userHasSubscription = !!userSubscription;
  const isSameSubscriptionItem = userSubscription?.id === subscriptionNotification.id;

  const startingNewSubscription =
    isCreatingSubscription && userHasSubscription && !isSameSubscriptionItem;

  if (subscriptionNotification.status === 'canceled') {
    // immediate cancel:
    log('upsertSubscription :: Subscription canceled immediately');
    await dbWrite.customerSubscription.delete({ where: { userId: user.id } });
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
    await dbWrite.user.update({ where: { id: user.id }, data: { subscriptionId: null } });
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
    cancelAt:
      subscriptionNotification.scheduledChange?.action === 'cancel' &&
      subscriptionNotification.currentBillingPeriod?.endsAt
        ? new Date(subscriptionNotification.currentBillingPeriod?.endsAt)
        : null,
    canceledAt: subscriptionNotification.scheduledChange?.action === 'cancel' ? new Date() : null,
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
    dbWrite.user.update({
      where: { id: user.id },
      data: { subscriptionId: subscriptionNotification.id },
    }),
  ]);

  if (userSubscription?.status !== data.status && ['active', 'canceled'].includes(data.status)) {
    await playfab.trackEvent(user.id, {
      eventName: data.status === 'active' ? 'user_start_membership' : 'user_cancel_membership',
      productId: data.productId,
    });
  }

  const userVault = await dbRead.vault.findFirst({
    where: { userId: user.id },
  });

  // Get Stripe details on the vault:
  const product = await dbRead.product.findFirst({
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
          return createBuzzTransaction({
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
        })
      );
    }).catch(handleLogError);
  }
};

export const cancelSubscriptionPlan = async ({ userId }: { userId: number }) => {
  const subscription = await dbRead.customerSubscription.findFirst({
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
    throw throwNotFoundError('No active subscription found');
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
    await updatePaddleSubscription({
      subscriptionId: subscription.id,
      scheduledChange: {
        action: 'cancel',
        effectiveAt: isFreeTier ? 'immediately' : 'next_billing_period',
      },
    });

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
  const subscription = await dbRead.customerSubscription.findFirst({
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
      await updatePaddleSubscription({
        subscriptionId: subscription.id,
        items: [
          {
            priceId,
            quantity: 1,
          },
        ],
        prorationBillingMode: 'full_immediately',
        onPaymentFailure: 'prevent_change',
      });
    }

    await sleep(500); // Waits for the webhook to update the subscription. Might be wishful thinking.

    await invalidateSession(userId);
    await getMultipliersForUser(userId, true);

    return true;
  } catch (e) {
    return new Error('Failed to update subscription');
  }
};
