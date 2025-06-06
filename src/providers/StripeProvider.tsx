import type { Stripe } from '@stripe/stripe-js';
import { useRef, useEffect } from 'react';
import { env } from '~/env/client';
import { useRouter } from 'next/router';
import { z } from 'zod';
import { showSuccessNotification } from '~/utils/notifications';
import { Anchor, Stack, Text } from '@mantine/core';
import { removeEmpty } from '~/utils/object-helpers';

// const stripePromise = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
//   ? loadStripe(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)
//   : null;

export const useStripePromise = () => {
  const ref = useRef<Promise<Stripe | null> | null>(null);

  useEffect(() => {
    if (!env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) return;
    if (!ref.current) {
      import('@stripe/stripe-js').then(({ loadStripe }) => {
        ref.current = loadStripe(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);
      });
    }
    return () => {
      ref.current = null;
    };
  }, []);

  return ref.current;
};

const schema = z.object({
  setup_intent: z.string().optional(),
  redirect_status: z.string().optional(),
});
export function StripeSetupSuccessProvider() {
  const router = useRouter();
  const parsed = schema.safeParse(router.query);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (parsed.success && isFirstRender.current) {
      isFirstRender.current = false;
      const { redirect_status: redirectStatus, setup_intent: setupIntent } = parsed.data;
      if (redirectStatus === 'succeeded' && setupIntent) {
        const { pathname, query } = router;
        router.replace(
          {
            pathname,
            query: removeEmpty({
              ...query,
              redirect_status: undefined,
              setup_intent: undefined,
              setup_intent_client_secret: undefined,
            }),
          },
          undefined,
          {
            shallow: true,
            scroll: false,
          }
        );

        showSuccessNotification({
          title: 'Payment method added',
          message: (
            <Stack gap={0}>
              <Text>Your payment method has been added successfully.</Text>
              <Text>
                You can manage your payment methods in your{' '}
                <Anchor href="/user/account#payment-methods">account settings</Anchor>.
              </Text>
            </Stack>
          ),
        });
      }
    }
  }, [parsed]);

  return null;
}
