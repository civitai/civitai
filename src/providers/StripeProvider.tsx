import { Elements } from '@stripe/react-stripe-js';
import { loadStripe, Stripe } from '@stripe/stripe-js';
import { useRef, useEffect } from 'react';
import { env } from '~/env/client.mjs';

const stripePromise = loadStripe(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);

export const useStripePromise = () => {
  const ref = useRef<Promise<Stripe | null> | null>(null);

  useEffect(() => {
    ref.current = stripePromise;
    return () => {
      ref.current = null;
    };
  }, []);

  return ref.current;
};
export function StripeProvider({ children }: { children: React.ReactNode }) {
  return <Elements stripe={stripePromise}>{children}</Elements>;
}
