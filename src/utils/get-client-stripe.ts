import { env } from '~/env/client.mjs';
import { Stripe, loadStripe } from '@stripe/stripe-js';

export const getClientStripe = () => {
  if (!env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) {
    return null;
  }

  return loadStripe(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) as Promise<Stripe>;
};
