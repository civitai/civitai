import { PaymentProvider } from '@prisma/client';
import { env } from '~/env/server.mjs';
import { dbRead } from '~/server/db/client';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { createLogger } from '~/utils/logging';

const baseUrl = getBaseUrl();
const log = createLogger('subscriptions', 'blue');

export const getPlans = async ({
  paymentProvider = PaymentProvider.Stripe,
}: {
  paymentProvider?: PaymentProvider;
}) => {
  const products = await dbRead.product.findMany({
    where: {
      provider: paymentProvider,
      active: true,
      prices: { some: { type: 'recurring', active: true } },
    },
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
        where: {
          active: true,
        },
      },
    },
  });

  // Only show the default price for a subscription product
  return products
    .filter(({ metadata }) => {
      return env.TIER_METADATA_KEY ? !!(metadata as any)?.[env.TIER_METADATA_KEY] : true;
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
