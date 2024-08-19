import { useIsMutating } from '@tanstack/react-query';
import { cloneElement, useCallback, useEffect } from 'react';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { getClientStripe } from '~/utils/get-client-stripe';
import { trpc } from '~/utils/trpc';
import Router from 'next/router';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Button, Stack, Text } from '@mantine/core';
import { openContextModal } from '@mantine/modals';
import { showErrorNotification } from '~/utils/notifications';
import { usePaddle } from '~/providers/PaddleProvider';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';
import { PaymentProvider } from '@prisma/client';
import { CheckoutEventsData } from '@paddle/paddle-js';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';

export function SubscribeButton({
  children,
  priceId,
  onSuccess,
}: {
  children:
    | React.ReactElement
    | ((props: { onClick: () => void; disabled: boolean; loading: boolean }) => React.ReactElement);
  priceId: string;
  onSuccess?: () => void;
}) {
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const mutateCount = useIsMutating();
  const paymentProvider = usePaymentProvider();
  const { subscription, subscriptionLoading } = useActiveSubscription();
  const { paddle, emitter } = usePaddle();
  const {
    mutate: stripeCreateSubscriptionSession,
    isLoading: isLoadingStripeCrateSubscriptionSession,
  } = trpc.stripe.createSubscriptionSession.useMutation({
    async onSuccess({ sessionId, url }) {
      await currentUser?.refresh();
      await queryUtils.subscriptions.getUserSubscription.reset();
      onSuccess?.();
      if (url) Router.push(url);
      else if (sessionId) {
        const stripe = await getClientStripe();
        if (!stripe) {
          return;
        }
        await stripe.redirectToCheckout({ sessionId });
      }
    },
    async onError(error) {
      showErrorNotification({
        title: 'Sorry, there was an error while trying to subscribe. Please try again later',
        error: new Error(error.message),
      });
    },
  });
  const { mutate: paddleUpdateSubscription, isLoading: isLoadingPaddleUpdateSubscription } =
    trpc.paddle.updateSubscription.useMutation({
      async onSuccess() {
        await currentUser?.refresh();
        await queryUtils.subscriptions.getUserSubscription.reset();
        onSuccess?.();
        return Router.push('/user/membership');
      },
      async onError(error) {
        showErrorNotification({
          title: 'Sorry, there was an error while trying to subscribe. Please try again later',
          error: new Error(error.message),
        });
      },
    });

  const isLoading = isLoadingStripeCrateSubscriptionSession || isLoadingPaddleUpdateSubscription;

  const handleClick = () => {
    if (subscription && paymentProvider !== subscription.product.provider) {
      showErrorNotification({
        title: 'You already have an active subscription with a different provider',
        error: new Error('You already have an active subscription with a different provider'),
      });

      return;
    }

    if (paymentProvider === PaymentProvider.Stripe) {
      stripeCreateSubscriptionSession({ priceId });
    }

    if (paymentProvider === PaymentProvider.Paddle) {
      if (subscription) {
        paddleUpdateSubscription({ priceId });
      } else {
        paddle?.Checkout.open({
          items: [
            {
              priceId,
              quantity: 1,
            },
          ],
          customer: {
            email: currentUser?.email as string,
          },
          settings: {
            showAddDiscounts: false,
            theme: 'dark',
          },
        });
      }
    }
  };

  const handleAddEmail = () => {
    openContextModal({
      modal: 'onboarding',
      title: 'Your Account',
      withCloseButton: false,
      closeOnClickOutside: false,
      closeOnEscape: false,
      innerProps: {},
    });
  };

  const trackCheckout = useCallback(
    async (data?: CheckoutEventsData) => {
      if (data?.items.some((item) => item.price_id === priceId)) {
        // This price was purchased...:
        await currentUser?.refresh();
        onSuccess?.();
      }
    },
    [priceId, currentUser, onSuccess]
  );

  useEffect(() => {
    if (emitter && paymentProvider === PaymentProvider.Paddle) {
      emitter.on('checkout.completed', trackCheckout);
    }
    return () => {
      emitter?.off('checkout.completed', trackCheckout);
    };
  }, [emitter, priceId, paymentProvider, trackCheckout]);

  if (currentUser && !currentUser.email)
    return (
      <Button onClick={handleAddEmail} sx={{ height: 50 }}>
        <Stack align="center" spacing={0}>
          <Text align="center" sx={{ lineHeight: 1.1 }}>
            Subscribe
          </Text>
          <Text align="center" size="xs" sx={{ color: 'rgba(255,255,255,.7)' }}>
            *Email Required. Click here to set it.
          </Text>
        </Stack>
      </Button>
    );

  return (
    <LoginPopover>
      {typeof children === 'function'
        ? children({
            onClick: handleClick,
            loading: isLoading,
            disabled: (!isLoading && mutateCount > 0) || subscriptionLoading,
          })
        : cloneElement(children, {
            onClick: handleClick,
            loading: isLoading,
            disabled: (!isLoading && mutateCount > 0) || subscriptionLoading,
          })}
    </LoginPopover>
  );
}
