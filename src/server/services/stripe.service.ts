import { Currency } from '~/shared/utils/prisma/enums';
import type { MetadataParam } from '@stripe/stripe-js';
import { chunk } from 'lodash-es';
import type { Stripe } from 'stripe';
import { env } from '~/env/server';
import { constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
  withRetries,
} from '~/server/utils/errorHandling';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import { refreshSession } from '~/server/auth/session-invalidation';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { createLogger } from '~/utils/logging';
import { formatPriceForDisplay } from '~/utils/number-helpers';

import * as Schema from '../schema/stripe.schema';
import type { PaymentMethodDeleteInput } from '../schema/stripe.schema';
import {
  completeStripeBuzzTransaction,
  createBuzzTransaction,
  getMultipliersForUser,
} from './buzz.service';
import { getOrCreateVault } from '~/server/services/vault.service';
import { sleep } from '~/server/utils/concurrency-helpers';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { subscriptionProductMetadataSchema } from '~/server/schema/subscriptions.schema';
import { TransactionType, buzzConstants } from '~/shared/constants/buzz.constants';
import { invalidateSubscriptionCaches } from '~/server/utils/subscription.utils';
import { userUpdateCounter } from '~/server/prom/client';

const baseUrl = getBaseUrl('green'); // Stripe lives in civitai green
const log = createLogger('stripe', 'blue');

export const createCustomer = async ({ id, email }: Schema.CreateCustomerInput) => {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');

  const user = await dbWrite.user.findUnique({ where: { id }, select: { customerId: true } });
  if (!user?.customerId) {
    const customer = await stripe.customers.create({ email });

    await dbWrite.user.update({ where: { id }, data: { customerId: customer.id } });

    userUpdateCounter?.inc({ location: 'stripe.service:createCustomer' });

    await refreshSession(id);

    return customer.id;
  } else {
    return user.customerId;
  }
};

export const createSubscribeSession = async ({
  priceId,
  customerId,
  user,
}: Schema.CreateSubscribeSessionInput & {
  customerId?: string;
  user: Schema.CreateCustomerInput;
}) => {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');

  if (!customerId) {
    customerId = await createCustomer(user);
  }

  const products = await dbRead.product.findMany({});
  const membershipProducts = products.filter(({ metadata }) => {
    return !!(metadata as any)?.[env.TIER_METADATA_KEY];
  });

  // Check to see if this user has a subscription with Stripe
  const { data: subscriptions } = await stripe.subscriptions.list({
    customer: customerId,
  });
  const customer = await stripe.customers.retrieve(customerId);

  if (!customer || customer.deleted) {
    throw throwBadRequestError(`Could not find customer with id: ${customerId}`);
  }

  const price = await stripe.prices.retrieve(priceId);

  if (!price || !membershipProducts.find((x) => x.id === (price.product as string))) {
    throw throwNotFoundError(`The product you are trying to purchase does not exists`);
  }

  const activeSubscription = subscriptions.find((x) => x.status !== 'canceled');
  const subscriptionItem = activeSubscription?.items.data.find((d) =>
    membershipProducts.some((p) => p.id === (d.price.product as string))
  );
  const activeProduct = membershipProducts.find((p) => p.id === subscriptionItem?.price.product);
  const priceProduct = products.find((p) => p.id === price.product);
  const oldTier = ((activeProduct?.metadata ?? {}) as SubscriptionProductMetadata)?.tier;
  const newTier = ((priceProduct?.metadata ?? {}) as SubscriptionProductMetadata).tier;

  const isUpgrade =
    activeSubscription &&
    constants.memberships.tierOrder.indexOf(oldTier) <
      constants.memberships.tierOrder.indexOf(newTier);

  if (activeSubscription) {
    if (!subscriptionItem) {
      throw throwBadRequestError(
        `Your subscription does not have a main plan. Please contact administration`
      );
    }

    const isActivePrice = subscriptionItem.price.id === price.id;
    if (!isActivePrice) {
      // Confirm user has a default credit card:
      if (!customer.default_source) {
        // Attempt to get and set outselves:
        const paymentMethods = await stripe.paymentMethods.list({
          customer: customerId,
          type: 'card',
        });

        if (paymentMethods.data.length === 0) {
          return {
            sessionId: null,
            url: `/user/account?missingPaymentMethod=true&tier=${newTier}#payment-methods`,
          };
        } else {
          // Set the first card as the default:
          await stripe.customers.update(customerId, {
            invoice_settings: {
              default_payment_method: paymentMethods.data[0].id,
            },
          });
        }
      }

      const isFounder =
        (activeProduct?.metadata as SubscriptionProductMetadata)?.tier ===
        constants.memberships.founderDiscount.tier;

      const discounts = [];

      if (
        isUpgrade &&
        isFounder &&
        new Date() < constants.memberships.founderDiscount.maxDiscountDate
      ) {
        // Create a custom discount for founders to get $5 off
        const coupon = await stripe.coupons.create({
          duration: 'once',
          percent_off: constants.memberships.founderDiscount.discountPercent,
          max_redemptions: 1,
          metadata: {
            customerId,
          },
        });

        discounts.push({
          coupon: coupon.id,
        });
      }

      const items = [
        {
          id: subscriptionItem.id,
          price: price.id,
        },
      ];

      await stripe.subscriptions.update(subscriptionItem.subscription as string, {
        items,
        billing_cycle_anchor: isUpgrade ? 'now' : 'unchanged',
        proration_behavior: 'none',
        // Makes it so that if a sub. is not paid, it won't start right away. Should cover us for failed payments during upgrades
        payment_behavior: isUpgrade ? 'default_incomplete' : undefined,
        // @ts-ignore This is valid as per stripe's documentation
        discounts,
      });

      await refreshSession(user.id);
      return {
        sessionId: null,
        url: isUpgrade
          ? `/payment/success?cid=${customerId.slice(-8)}`
          : `/user/membership?downgraded=true&tier=${newTier}`,
      };
    } else {
      const { url } = await createManageSubscriptionSession({ customerId });
      await refreshSession(user.id);
      return { sessionId: null, url };
    }
  }

  // array of items we are charging the customer
  const lineItems = [
    {
      price: priceId,
      quantity: 1,
    },
  ];

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: lineItems,
    success_url: `${baseUrl}/payment/success?cid=${customerId.slice(-8)}`,
    cancel_url: `${baseUrl}/pricing?canceled=true`,
    allow_promotion_codes: true,
  });

  return { sessionId: session.id, url: session.url };
};

// export const createPortalSession = async ({ customerId }: { customerId: string }) => {
//   const stripe = await getServerStripe();
//   if (!stripe) throw throwBadRequestError('Stripe is not available');
//   const session = await stripe.billingPortal.sessions.create({
//     customer: customerId,
//     return_url: `${baseUrl}/pricing`,
//   });

//   return { url: session.url };
// };

export const createDonateSession = async ({
  customerId,
  user,
  returnUrl,
}: {
  customerId?: string;
  user: Schema.CreateCustomerInput;
  returnUrl: string;
}) => {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');

  if (!customerId) {
    customerId = await createCustomer(user);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    cancel_url: returnUrl,
    line_items: [{ price: env.STRIPE_DONATE_ID, quantity: 1 }],
    mode: 'payment',
    submit_type: 'donate',
    success_url: `${baseUrl}/payment/success?type=donation&cid=${customerId.slice(-8)}`,
  });

  return { sessionId: session.id, url: session.url };
};

export const createManageSubscriptionSession = async ({ customerId }: { customerId: string }) => {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${baseUrl}/user/account`,
  });

  return { url: session.url };
};

export const createSubscriptionChangeSession = async ({
  customerId,
  subscriptionId,
  priceId,
  subscriptionItemId,
}: {
  customerId: string;
  subscriptionId: string;
  subscriptionItemId: string;
  priceId: string;
}) => {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${baseUrl}/user/account`,
    flow_data: {
      // @ts-ignore This is valid as per stripe's documentation
      type: 'subscription_update_confirm',
      subscription_update_confirm: {
        subscription: subscriptionId,
        items: [
          {
            id: subscriptionItemId,
            quantity: 1,
            price: priceId,
          },
        ],
      },
      after_completion: {
        type: 'redirect',
        redirect: {
          return_url: `${baseUrl}/payment/success?cid=${customerId.slice(-8)}`,
        },
      },
    },
  });

  return { url: session.url };
};

export const createCancelSubscriptionSession = async ({ customerId }: { customerId: string }) => {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');

  // Check to see if this user has a subscription with Stripe
  const { data: subscriptions } = await stripe.subscriptions.list({
    customer: customerId,
  });

  const activeSubscription = subscriptions.find((x) => x.status !== 'canceled');
  if (!activeSubscription) {
    throw throwBadRequestError(`No active subscription found`);
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${baseUrl}/user/account`,
    flow_data: {
      // @ts-ignore This is valid as per stripe's documentation
      type: 'subscription_cancel',
      subscription_cancel: {
        subscription: activeSubscription.id,
      },
    },
  });

  return { url: session.url };
};

export const createBuzzSession = async ({
  customerId,
  user,
  returnUrl,
  priceId,
  customAmount,
}: Schema.CreateBuzzSessionInput & {
  customerId?: string;
  user: Schema.CreateCustomerInput;
}) => {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');

  if (!customerId) {
    customerId = await createCustomer(user);
  }

  const price = await dbRead.price.findUnique({
    where: { id: priceId },
    select: { productId: true, currency: true, type: true },
  });

  if (!price)
    throw throwNotFoundError(`The product you are trying to purchase does not exists: ${priceId}`);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    cancel_url: returnUrl,
    line_items: [
      customAmount
        ? {
            price_data: {
              unit_amount: customAmount * 100,
              currency: price.currency,
              product: price.productId,
            },
            quantity: 1,
          }
        : { price: priceId, quantity: 1 },
    ],
    mode: price.type === 'recurring' ? 'subscription' : 'payment',
    success_url: returnUrl,
  });

  return { sessionId: session.id, url: session.url };
};

export const upsertSubscription = async (
  subscription: Stripe.Subscription,
  customerId: string,
  eventDate: Date,
  eventType: string
) => {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');

  const isUpdatingSubscription = eventType === 'customer.subscription.updated';
  if (isUpdatingSubscription) {
    // We need to wait a bit to avoid race conditions
    await sleep(5000);
  }

  const user = await dbWrite.user.findFirst({
    where: { customerId: customerId },
    select: {
      id: true,
      customerId: true,
      subscriptions: {
        where: {
          // Stripe only deals with green but user may have multiple subscriptions for different colors
          buzzType: 'green',
        },
        select: { id: true, updatedAt: true, status: true },
      },
    },
  });

  if (!user) throw throwNotFoundError(`User with customerId: ${customerId} not found`);

  const mainSubscription = user.subscriptions[0];
  const userHasSubscription = !!mainSubscription;
  const isSameSubscriptionItem = userHasSubscription && mainSubscription?.id === subscription.id;
  const isCreatingSubscription = eventType === 'customer.subscription.created';
  const isCancelingSubscription = eventType === 'customer.subscription.deleted';

  const startingNewSubscription =
    isCreatingSubscription && userHasSubscription && !isSameSubscriptionItem;

  log('Subscription event:', eventType);

  if (isCancelingSubscription && subscription.cancel_at === null) {
    // immediate cancel:
    log('Subscription canceled immediately');
    await dbWrite.customerSubscription.delete({ where: { id: mainSubscription.id } });
    await invalidateSubscriptionCaches(user.id);
    return;
  }

  if (startingNewSubscription) {
    log('Subscription id changed, deleting old subscription');
    if (mainSubscription) {
      await dbWrite.customerSubscription.delete({ where: { id: mainSubscription.id } });
    }
  } else if (userHasSubscription && isCreatingSubscription) {
    log('Subscription already up to date');
    return;
  }

  // Get product to determine buzzType
  const productId = subscription.items.data[0].price.product as string;
  const product = await dbRead.product.findFirst({
    where: { id: productId },
  });

  const productMeta = product?.metadata as any;
  const buzzType = (productMeta?.buzzType ?? 'green') as string;

  const data = {
    id: subscription.id,
    userId: user.id,
    buzzType,
    metadata: subscription.metadata,
    status: subscription.status,
    // as far as I can tell, there are never multiple items in this array
    priceId: subscription.items.data[0].price.id,
    productId,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancelAt: subscription.cancel_at ? toDateTime(subscription.cancel_at) : null,
    canceledAt: subscription.canceled_at ? toDateTime(subscription.canceled_at) : null,
    currentPeriodStart: toDateTime(subscription.current_period_start),
    currentPeriodEnd: toDateTime(subscription.current_period_end),
    createdAt: toDateTime(subscription.created),
    endedAt: subscription.ended_at ? toDateTime(subscription.ended_at) : null,
    updatedAt: eventDate,
  };

  await dbWrite.$transaction([
    dbWrite.customerSubscription.upsert({
      where: {
        userId_buzzType: {
          userId: user.id,
          buzzType,
        },
      },
      update: data,
      create: data,
    }),
  ]);

  const userVault = await dbRead.vault.findFirst({
    where: { userId: user.id },
  });

  // Product already fetched above for buzzType

  if (data.status === 'canceled' && userVault) {
    await dbWrite.vault.update({
      where: { userId: user.id },
      data: {
        storageKb: 0, // Reset storage to 0
      },
    });
  } else if (data.status === 'active') {
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

  await invalidateSubscriptionCaches(user.id);
};

export const toDateTime = (secs: number) => {
  const t = new Date('1970-01-01T00:30:00Z'); // Unix epoch start.
  t.setSeconds(secs);
  return t;
};

export const upsertProductRecord = async (product: Stripe.Product) => {
  const productData = {
    id: product.id,
    active: product.active,
    name: product.name,
    description: product.description ?? null,
    metadata: product.metadata,
    defaultPriceId: product.default_price as string | null,
  };

  await dbWrite.product.upsert({
    where: { id: product.id },
    update: productData,
    create: productData,
  });

  return productData;
};

export const upsertPriceRecord = async (price: Stripe.Price) => {
  const priceData = {
    id: price.id,
    productId: typeof price.product === 'string' ? price.product : '',
    active: price.active,
    currency: price.currency,
    description: price.nickname ?? undefined,
    type: price.type,
    unitAmount: price.unit_amount,
    interval: price.recurring?.interval,
    intervalCount: price.recurring?.interval_count,
    metadata: price.metadata,
  };
  await dbWrite.price.upsert({
    where: { id: price.id },
    update: priceData,
    create: priceData,
  });
  return priceData;
};

export const initStripePrices = async () => {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');
  const { data: prices } = await stripe.prices.list();
  await Promise.all(
    prices.map(async (price) => {
      await upsertPriceRecord(price);
    })
  );
};

export const initStripeProducts = async () => {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');
  const { data: products } = await stripe.products.list();
  await Promise.all(
    products.map(async (product) => {
      await upsertProductRecord(product);
    })
  );
};

export const manageCheckoutPayment = async (sessionId: string, customerId: string) => {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');
  const user = await dbWrite.user.findUniqueOrThrow({
    where: { customerId },
    select: { id: true, customerId: true },
  });
  const { line_items, payment_status } = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['line_items'],
  });

  const purchases =
    line_items?.data.map((data) => ({
      userId: user.id,
      priceId: data.price?.id,
      productId: data.price?.product as string | undefined,
      status: payment_status,
    })) ?? [];

  if (purchases.length > 0) {
    await dbWrite.purchase.createMany({ data: purchases });
  }
};

export const manageInvoicePaid = async (invoice: Stripe.Invoice) => {
  // Check if user exists and has a customerId
  // Use write db to avoid replication lag between webhook requests
  const user = await dbWrite.user.findUniqueOrThrow({
    where: { customerId: invoice.customer as string },
    select: { id: true, customerId: true },
  });

  if (user && !user.customerId) {
    // Since we're handling an invoice, we assume that the user
    // is already created in stripe. We just update in our records
    await dbWrite.user.update({
      where: { id: user.id },
      data: { customerId: invoice.customer as string },
    });

    const { userUpdateCounter } = await import('~/server/prom/client');
    userUpdateCounter?.inc({ location: 'stripe.service:handleInvoicePaid' });
  }

  const purchases = invoice.lines.data.map((data) => ({
    userId: user.id,
    priceId: data.price?.id,
    productId: data.price?.product as string | undefined,
    status: invoice.status,
  }));

  await dbWrite.purchase.createMany({ data: purchases });

  // Don't check for subscription active because there is a chance it hasn't been updated yet
  if (
    invoice.subscription &&
    user &&
    invoice.billing_reason &&
    ['subscription_cycle', 'subscription_create', 'subscription_update'].includes(
      invoice.billing_reason
    )
  ) {
    const products = (await dbRead.product.findMany()).filter(
      (p) => !!(p.metadata as any)?.[env.TIER_METADATA_KEY]
    );
    const billedProduct = products.find((p) =>
      invoice.lines.data.some((l) => l.price?.product === p.id)
    );

    if (!billedProduct) {
      return;
    }

    const billedProductMeta = (billedProduct?.metadata ?? {}) as SubscriptionProductMetadata;
    const mainPurchase = purchases.find((p) => p.productId === billedProduct?.id);

    if (!mainPurchase) {
      // Give you no buzz. You no pay.
      return;
    }

    await withRetries(() =>
      createBuzzTransaction({
        fromAccountId: 0,
        toAccountId: user.id,
        toAccountType: (billedProductMeta.buzzType as any) ?? 'yellow', // Default to yellow if not specified
        type: TransactionType.Purchase,
        externalTransactionId: invoice.id,
        amount: billedProductMeta.monthlyBuzz ?? 3000, // assume a min of 3000.
        description: `Membership bonus`,
        details: { invoiceId: invoice.id },
      })
    ).catch(handleLogError);
  }
};

export const cancelSubscription = async ({
  userId,
  subscriptionId,
}: {
  userId?: number;
  subscriptionId?: string;
}) => {
  if (!subscriptionId && userId) {
    const subscription = await dbWrite.customerSubscription.findFirst({
      where: {
        userId,
        product: {
          provider: 'Stripe',
        },
        status: {
          in: ['active', 'past_due', 'trialing'],
        },
      },
      select: { id: true },
    });
    if (!subscription) return;
    subscriptionId = subscription.id;
  }

  if (!subscriptionId) return;
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');

  await stripe.subscriptions.del(subscriptionId);
};

export const getBuzzPackages = async () => {
  const [buzzProduct] = await dbRead.product.findMany({
    where: { active: true, metadata: { path: ['tier'], equals: 'buzz' } },
    select: {
      id: true,
      name: true,
      description: true,
      defaultPriceId: true,
      prices: {
        where: { active: true },
        orderBy: { unitAmount: { sort: 'asc', nulls: 'last' } },
        select: {
          id: true,
          description: true,
          unitAmount: true,
          currency: true,
          metadata: true,
        },
      },
    },
  });

  return buzzProduct.prices.map(({ metadata, description, ...price }) => {
    const meta = Schema.buzzPriceMetadataSchema.safeParse(metadata);

    return {
      ...price,
      name: description,
      buzzAmount: meta.success ? meta.data.buzzAmount : null,
      description: meta.success ? meta.data.bonusDescription : null,
    };
  });
};

const futureUsageNotSupportedPaymentMethods = ['customer_balance', 'wechat_pay'];

export const getPaymentIntent = async ({
  unitAmount,
  currency = Currency.USD,
  metadata,
  paymentMethodTypes,
  customerId,
  user,
  setupFuturePayment = true,
}: Schema.PaymentIntentCreationSchema & {
  user: { id: number; email: string };
  customerId?: string;
}) => {
  // TODO: If a user doesn't exist, create one. Initially, this will be protected, but ideally, we should create the user on our end
  if (!customerId) {
    customerId = await createCustomer(user);
  }

  if (unitAmount < buzzConstants.minChargeAmount) {
    throw throwBadRequestError(
      `Minimum purchase amount is $${formatPriceForDisplay(buzzConstants.minChargeAmount / 100)}`
    );
  }

  if (unitAmount > buzzConstants.maxChargeAmount) {
    throw throwBadRequestError(
      `Maximum purchase amount is $${formatPriceForDisplay(buzzConstants.maxChargeAmount / 100)}`
    );
  }

  if (unitAmount !== metadata.buzzAmount / 10) {
    // Safeguard against tampering with the amount on the client side
    throw new Error('There was an error while creating your order. Please try again later.');
  }

  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');
  const paymentIntent = await stripe.paymentIntents.create({
    amount: unitAmount,
    currency,
    automatic_payment_methods:
      !paymentMethodTypes && setupFuturePayment
        ? {
            enabled: true,
          }
        : undefined,
    customer: customerId,
    metadata: metadata as MetadataParam,
    payment_method_types: setupFuturePayment
      ? paymentMethodTypes || undefined
      : futureUsageNotSupportedPaymentMethods,
    setup_future_usage: setupFuturePayment ? 'off_session' : undefined,
  });

  return {
    clientSecret: paymentIntent.client_secret,
    paymentMethodTypes: paymentIntent.payment_method_types,
  };
};

export const getPaymentIntentsForBuzz = async ({
  userId,
  startingAt,
  endingAt,
}: Schema.GetPaymentIntentsForBuzzSchema) => {
  let customer: string | undefined;
  if (userId) {
    const user = await dbRead.user.findUnique({
      where: { id: userId },
      select: { customerId: true },
    });

    if (!user) throw new Error(`No user with id ${userId}`);

    customer = user.customerId ?? undefined; // undefined is required for the stripe api
  }

  // Converting to unix timestamps because that's what the stripe api expects
  const unixStartingAt = startingAt ? Math.floor(startingAt.getTime() / 1000) : undefined;
  const unixEndingAt = endingAt ? Math.floor(endingAt.getTime() / 1000) : undefined;

  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');
  const paymentIntents = await stripe.paymentIntents.list({
    customer,
    limit: 100, // max limit is 100
    created:
      unixStartingAt || unixEndingAt ? { gte: unixStartingAt, lte: unixEndingAt } : undefined,
  });

  const filteredPayments = paymentIntents.data.filter(
    (intent) =>
      intent.status === 'succeeded' &&
      intent.metadata.type === 'buzzPurchase' &&
      !intent.metadata.transactionId
  );
  const batches = chunk(filteredPayments, 10);

  const processedPurchases: Array<{ transactionId: string }> = [];
  for (const batch of batches) {
    const processed = await Promise.all(
      batch.map((intent) => {
        const metadata = intent.metadata as Schema.PaymentIntentMetadataSchema;

        return completeStripeBuzzTransaction({
          amount: metadata.buzzAmount ?? intent.amount * 10,
          stripePaymentIntentId: intent.id,
          details: {
            userId,
            unitAmount: intent.amount,
            buzzAmount: intent.amount * 10,
            type: 'buzzPurchase',
            ...intent.metadata,
          },
          userId: metadata.userId ?? userId,
        });
      })
    );
    processedPurchases.concat(processed);
  }

  return processedPurchases;
};

export const getSetupIntent = async ({
  paymentMethodTypes,
  customerId,
  user,
}: Schema.SetupIntentCreateSchema & {
  user: { id: number; email: string };
  customerId?: string;
}) => {
  if (!customerId) {
    customerId = await createCustomer(user);
  }

  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');
  const setupIntent = await stripe.setupIntents.create({
    automatic_payment_methods: !paymentMethodTypes
      ? {
          enabled: true,
        }
      : undefined,
    customer: customerId,
    payment_method_types: paymentMethodTypes || undefined,
  });

  return {
    clientSecret: setupIntent.client_secret,
  };
};

export const getCustomerPaymentMethods = async (customerId: string) => {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');
  const paymentMethods = await stripe.paymentMethods.list({
    customer: customerId,
  });

  return paymentMethods.data;
};

export const deleteCustomerPaymentMethod = async ({
  paymentMethodId,
  userId,
  isModerator,
}: PaymentMethodDeleteInput & {
  userId: number;
  isModerator: boolean;
}) => {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');
  const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);

  if (!paymentMethod) {
    throwBadRequestError(`No payment method with id ${paymentMethodId}`);
  }

  const user = await dbWrite.user.findUnique({
    where: { id: userId },
    select: { customerId: true },
  });

  if (!user && !isModerator) throw throwBadRequestError(`No user with id ${userId}`);

  if (user?.customerId !== paymentMethod.customer && !isModerator) {
    throw throwAuthorizationError(`Payment method does not belong to user with id ${userId}`);
  }

  return await stripe.paymentMethods.detach(paymentMethodId);
};
