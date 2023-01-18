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

  const user = await prisma.user.findUnique({ where: { id }, select: { stripeCustomer: true } });
  if (!user?.stripeCustomer) {
    const customer = await stripe.customers.create({ email });

    await prisma.user.update({ where: { id }, data: { stripeCustomer: customer.id } });

    return customer.id;
  } else {
    return user.stripeCustomer;
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
    cancel_url: `${baseUrl}/payment/cancelled`,
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
