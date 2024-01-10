import { Elements } from '@stripe/react-stripe-js';
import { loadStripe, Stripe } from '@stripe/stripe-js';
import { useRef, useEffect } from 'react';
import { env } from '~/env/client.mjs';
import { useRouter } from 'next/router';
import { z } from 'zod';
import { commaDelimitedStringArray } from '~/utils/zod-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { Anchor, Stack, Text } from '@mantine/core';
import { removeEmpty } from '~/utils/object-helpers';

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
            <Stack spacing={0}>
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
