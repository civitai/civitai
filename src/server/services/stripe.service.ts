import { invalidateSession } from '~/server/utils/session-helpers';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import * as Schema from '../schema/stripe.schema';
import { prisma } from '~/server/db/client';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import { Stripe } from 'stripe';
import { getBaseUrl } from '~/server/utils/url-helpers';

const baseUrl = getBaseUrl();

export const getPlans = async () => {
  const stripe = await getServerStripe();

  const { data: prices } = await stripe.prices.list({ active: true, type: 'recurring' });

  const plans = await Promise.all(
    prices.map(async (price) => {
      const product =
        typeof price.product === 'string'
          ? await stripe.products.retrieve(price.product)
          : (price.product as Stripe.Product);

      return {
        name: product.name,
        price: price.unit_amount ?? 0,
        priceId: price.id,
        interval: price.recurring?.interval,
        currency: price.currency,
      };
    })
  );

  return plans.sort((a, b) => a.price - b.price);
};

export const createCustomer = async ({ id, email }: Schema.CreateCustomerInput) => {
  const stripe = await getServerStripe();

  const user = await prisma.user.findUnique({ where: { id }, select: { customerId: true } });
  if (!user?.customerId) {
    const customer = await stripe.customers.create({ email });

    await prisma.user.update({ where: { id }, data: { customerId: customer.id } });
    invalidateSession(id);

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
    payment_method_types: ['card'],
    line_items: lineItems,
    success_url: `${baseUrl}/payment/success`,
    cancel_url: `${baseUrl}/pricing`,
  });

  return { sessionId: session.id };
};

export const createPortalSession = async ({ customerId }: { customerId: string }) => {
  const stripe = await getServerStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${baseUrl}/pricing`,
  });

  return { url: session.url };
};

export const manageSubscriptionStatusChange = async (
  subscriptionId: string,
  customerId: string
) => {
  const stripe = await getServerStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  const user = await prisma.user.findFirst({
    where: { customerId: customerId },
    select: { id: true, customerId: true, subscriptionId: true },
  });

  if (!user) throw throwNotFoundError(`User with customerId: ${customerId} not found`);

  const data = {
    id: subscription.id,
    userId: user.id,
    metadata: subscription.metadata,
    status: subscription.status,
    priceId: subscription.items.data[0].price.id,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancelAt: subscription.cancel_at ? toDateTime(subscription.cancel_at) : null,
    canceledAt: subscription.canceled_at ? toDateTime(subscription.canceled_at) : null,
    currentPeriodStart: toDateTime(subscription.current_period_start),
    currentPeriodEnd: toDateTime(subscription.current_period_end),
    createdAt: toDateTime(subscription.created),
    endedAt: subscription.ended_at ? toDateTime(subscription.ended_at) : null,
  };

  await prisma.$transaction([
    prisma.subscription.upsert({ where: { id: data.id }, update: data, create: data }),
    prisma.user.update({ where: { id: user.id }, data: { subscriptionId: subscription.id } }),
  ]);

  invalidateSession(user.id);
};

export const toDateTime = (secs: number) => {
  const t = new Date('1970-01-01T00:30:00Z'); // Unix epoch start.
  t.setSeconds(secs);
  return t;
};

export const createManageSubscriptionSession = async ({ customerId }: { customerId: string }) => {
  const stripe = await getServerStripe();

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${baseUrl}/user/account`,
  });

  return { url: session.url };
};
