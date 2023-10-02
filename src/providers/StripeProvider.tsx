import { Elements } from '@stripe/react-stripe-js';
import { loadStripe, Stripe } from '@stripe/stripe-js';
import { env } from '~/env/client.mjs';
import React, { useEffect, useRef } from 'react';

export const useStripePromise = () => {
  const ref = useRef<Promise<Stripe | null> | null>(null);

  useEffect(() => {
    ref.current = loadStripe(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);

    return () => {
      ref.current = null;
    };
  }, []);

  return ref.current;
};

export function StripeProvider({ children }: { children: React.ReactNode }) {
  const stripePromise = useStripePromise();
  return <Elements stripe={stripePromise}>{children}</Elements>;
}
