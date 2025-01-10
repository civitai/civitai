import { env } from '~/env/client';

export const getClientStripe = async () => {
  if (!env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) return null;

  return import('@stripe/stripe-js').then(({ loadStripe }) =>
    loadStripe(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!)
  );
};
