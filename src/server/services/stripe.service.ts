import { chunk } from 'lodash-es';
import { invalidateSession } from '~/server/utils/session-helpers';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
  withRetries,
} from '~/server/utils/errorHandling';
import * as Schema from '../schema/stripe.schema';
import { dbWrite, dbRead } from '~/server/db/client';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import { Stripe } from 'stripe';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { env } from '~/env/server.mjs';
import { createLogger } from '~/utils/logging';
import { playfab } from '~/server/playfab/client';
import { Currency } from '@prisma/client';
import { MetadataParam } from '@stripe/stripe-js';
import { constants } from '~/server/common/constants';
import { formatPriceForDisplay } from '~/utils/number-helpers';
import { completeStripeBuzzTransaction, createBuzzTransaction } from './buzz.service';
import { TransactionType } from '../schema/buzz.schema';
import { PaymentMethodDeleteInput } from '../schema/stripe.schema';

const baseUrl = getBaseUrl();
const log = createLogger('stripe', 'blue');

export const getPlans = async () => {
  const products = await dbRead.product.findMany({
    where: { active: true, prices: { some: { type: 'recurring', active: true } } },
    select: {
      id: true,
      name: true,
      description: true,
      metadata: true,
      defaultPriceId: true,
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
      },
    },
  });

  // Only show the default price for a subscription product
  return products
    .filter(({ metadata }) => {
      return !!(metadata as any)?.[env.STRIPE_METADATA_KEY];
    })
    .map(({ prices, ...product }) => {
      const price = prices.filter((x) => x.id === product.defaultPriceId)[0];
      return {
        ...product,
        price: { ...price, unitAmount: price.unitAmount ?? 0 },
      };
    })
    .sort((a, b) => a.price.unitAmount - b.price.unitAmount);
};

export const getUserSubscription = async ({ userId }: Schema.GetUserSubscriptionInput) => {
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
      product: {
        select: {
          id: true,
          name: true,
          description: true,
        },
      },
      price: {
        select: {
          id: true,
          unitAmount: true,
          interval: true,
          intervalCount: true,
          currency: true,
        },
      },
    },
  });

  if (!subscription)
    throw throwNotFoundError(`Could not find subscription for user with id: ${userId}`);

  return {
    ...subscription,
    price: { ...subscription.price, unitAmount: subscription.price.unitAmount ?? 0 },
  };
};

export const createCustomer = async ({ id, email }: Schema.CreateCustomerInput) => {
  const stripe = await getServerStripe();

  const user = await dbWrite.user.findUnique({ where: { id }, select: { customerId: true } });
  if (!user?.customerId) {
    const customer = await stripe.customers.create({ email });

    await dbWrite.user.update({ where: { id }, data: { customerId: customer.id } });
    await invalidateSession(id);

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

  if (!customerId) {
    customerId = await createCustomer(user);
  }

  // Check to see if this user has a subscription with Stripe
  const { data: subscriptions } = await stripe.subscriptions.list({
    customer: customerId,
  });

  if (subscriptions.filter((x) => x.status !== 'canceled').length > 0) {
    const { url } = await createManageSubscriptionSession({ customerId });
    await invalidateSession(user.id);
    return { sessionId: null, url };
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

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${baseUrl}/user/account`,
  });

  return { url: session.url };
};

export const createBuzzSession = async ({
  customerId,
  user,
  returnUrl,
  priceId,
  customAmount,
}: Schema.CreateBuzzSessionInput & { customerId?: string; user: Schema.CreateCustomerInput }) => {
  const stripe = await getServerStripe();

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
  const user = await dbWrite.user.findFirst({
    where: { customerId: customerId },
    select: {
      id: true,
      customerId: true,
      subscriptionId: true,
      subscription: { select: { updatedAt: true, status: true } },
    },
  });

  if (!user) throw throwNotFoundError(`User with customerId: ${customerId} not found`);

  const userHasSubscription = !!user.subscriptionId;
  const startingNewSubscription = userHasSubscription && user.subscriptionId !== subscription.id;
  const isCreatingSubscription = eventType === 'customer.subscription.created';
  if (startingNewSubscription) {
    log('Subscription id changed, deleting old subscription');
    await dbWrite.customerSubscription.delete({ where: { id: user.subscriptionId as string } });
  } else if (userHasSubscription && isCreatingSubscription) {
    log('Subscription already up to date');
    return;
  }

  const data = {
    id: subscription.id,
    userId: user.id,
    metadata: subscription.metadata,
    status: subscription.status,
    // as far as I can tell, there are never multiple items in this array
    priceId: subscription.items.data[0].price.id,
    productId: subscription.items.data[0].price.product as string,
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
    isCreatingSubscription
      ? dbWrite.customerSubscription.create({ data })
      : dbWrite.customerSubscription.upsert({ where: { id: data.id }, update: data, create: data }),
    dbWrite.user.update({ where: { id: user.id }, data: { subscriptionId: subscription.id } }),
  ]);

  if (user.subscription?.status !== data.status && ['active', 'canceled'].includes(data.status)) {
    await playfab.trackEvent(user.id, {
      eventName: data.status === 'active' ? 'user_start_membership' : 'user_cancel_membership',
      productId: data.productId,
    });
  }

  await invalidateSession(user.id);
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
  const { data: prices } = await stripe.prices.list();
  await Promise.all(
    prices.map(async (price) => {
      await upsertPriceRecord(price);
    })
  );
};

export const initStripeProducts = async () => {
  const stripe = await getServerStripe();
  const { data: products } = await stripe.products.list();
  await Promise.all(
    products.map(async (product) => {
      await upsertProductRecord(product);
    })
  );
};

export const manageCheckoutPayment = async (sessionId: string, customerId: string) => {
  const stripe = await getServerStripe();
  const { line_items, payment_status } = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['line_items'],
  });

  const purchases =
    line_items?.data.map((data) => ({
      customerId,
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
  const user = await dbWrite.user.findUnique({
    where: { email: invoice.customer_email as string },
    select: { id: true, customerId: true },
  });
  if (user && !user.customerId) {
    // Since we're handling an invoice, we assume that the user
    // is already created in stripe. We just update in our records
    await dbWrite.user.update({
      where: { id: user.id },
      data: { customerId: invoice.customer as string },
    });
  }

  const purchases = invoice.lines.data.map((data) => ({
    customerId: invoice.customer as string,
    priceId: data.price?.id,
    productId: data.price?.product as string | undefined,
    status: invoice.status,
  }));

  await dbWrite.purchase.createMany({ data: purchases });

  // Don't check for subscription active because there is a chance it hasn't been updated yet
  if (invoice.subscription && user) {
    await withRetries(() =>
      createBuzzTransaction({
        fromAccountId: 0,
        toAccountId: user.id,
        type: TransactionType.Reward,
        externalTransactionId: invoice.id,
        amount: 5000, // Hardcoded for now cause we only have one subscription option
        description: 'Membership bonus',
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
      where: { userId },
      select: { id: true },
    });
    if (!subscription) return;
    subscriptionId = subscription.id;
  }

  if (!subscriptionId) return;
  const stripe = await getServerStripe();
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

export const getPaymentIntent = async ({
  unitAmount,
  currency = Currency.USD,
  metadata,
  paymentMethodTypes,
  customerId,
  user,
}: Schema.PaymentIntentCreationSchema & {
  user: { id: number; email: string };
  customerId?: string;
}) => {
  // TODO: If a user doesn't exist, create one. Initially, this will be protected, but ideally, we should create the user on our end
  if (!customerId) {
    customerId = await createCustomer(user);
  }

  if (unitAmount < constants.buzz.minChargeAmount) {
    throw throwBadRequestError(
      `Minimum purchase amount is $${formatPriceForDisplay(constants.buzz.minChargeAmount / 100)}`
    );
  }
  if (unitAmount > constants.buzz.maxChargeAmount) {
    throw throwBadRequestError(
      `Maximum purchase amount is $${formatPriceForDisplay(constants.buzz.maxChargeAmount / 100)}`
    );
  }

  const stripe = await getServerStripe();
  const paymentIntent = await stripe.paymentIntents.create({
    amount: unitAmount,
    currency,
    automatic_payment_methods: !paymentMethodTypes
      ? {
          enabled: true,
        }
      : undefined,
    customer: customerId,
    metadata: metadata as MetadataParam,
    payment_method_types: paymentMethodTypes || undefined,
    setup_future_usage: 'off_session',
  });

  return {
    clientSecret: paymentIntent.client_secret,
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
