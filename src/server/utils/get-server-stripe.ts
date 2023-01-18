import Stripe from 'stripe';
import { env as serverEnv } from '~/env/server.mjs';

let stripe: Stripe;
export const getServerStripe = async () => {
  if (!stripe)
    stripe = await new Stripe(serverEnv.STRIPE_SECRET_KEY, {
      typescript: true,
      apiVersion: '2022-11-15',
    });
  return stripe;
};
// export const getServerStripe = async () =>
//   new Stripe(serverEnv.STRIPE_SECRET_KEY, { typescript: true, apiVersion: '2022-11-15' });

// let stripePromise: Promise<Stripe | null>;
// export const getClientStripe = () => {
//   if (!stripePromise) {
//     console.log('client', env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
//     stripePromise = loadStripe(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
//   }
//   return stripePromise as Promise<Stripe>;
// };
