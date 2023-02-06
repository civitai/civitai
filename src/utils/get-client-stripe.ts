import { env } from '~/env/client.mjs';
import { Stripe, loadStripe } from '@stripe/stripe-js';

// let stripePromise: Promise<Stripe | null>;
export const getClientStripe = () => {
  return loadStripe(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) as Promise<Stripe>;
  // if (!stripePromise) {
  //   console.log('client', env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
  //   stripePromise = loadStripe(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
  // }
  // return stripePromise as Promise<Stripe>;
};
