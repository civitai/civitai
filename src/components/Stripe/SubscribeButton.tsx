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
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import type { CheckoutEventsData } from '@paddle/paddle-js';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { useHasPaddleSubscription, useMutatePaddle } from '~/components/Paddle/util';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { openGreenPurchaseAcknowledgement } from '~/components/Stripe/GreenPurchaseAcknowledgement';

function StripeSubscribeButton({ children, priceId, onSuccess, disabled }: Props) {
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const mutateCount = useIsMutating();
  const featureFlags = useFeatureFlags();

  const { mutate: stripeCreateSubscriptionSession, isLoading } =
    trpc.stripe.createSubscriptionSession.useMutation({
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

  const proceedWithSubscription = () => {
    stripeCreateSubscriptionSession({ priceId });
  };

  const handleClick = () => {
    // Show acknowledgement modal for green subscriptions
    if (featureFlags.isGreen) {
      openGreenPurchaseAcknowledgement(proceedWithSubscription, 'membership');
    } else {
      proceedWithSubscription();
    }
  };

  return (
    <LoginPopover>
      {typeof children === 'function'
        ? children({
            onClick: handleClick,
            loading: isLoading,
            disabled: (!isLoading && mutateCount > 0) || disabled,
          })
        : cloneElement(children, {
            onClick: handleClick,
            loading: isLoading,
            disabled: (!isLoading && mutateCount > 0) || disabled,
          })}
    </LoginPopover>
  );
}

function PaddleSubscribeButton({ children, priceId, onSuccess, disabled }: Props) {
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const mutateCount = useIsMutating();
  const { subscription, subscriptionLoading } = useActiveSubscription();
  const { paddle, emitter } = usePaddle();
  const { hasPaddleSubscription, isInitialLoading: loadingPaddleSubscriptionStatus } =
    useHasPaddleSubscription();

  const {
    updateSubscription: paddleUpdateSubscription,
    updatingSubscription: isLoading,
    getOrCreateCustomer,
    refreshSubscription,
  } = useMutatePaddle();

  const handleClick = async () => {
    if (subscription) {
      paddleUpdateSubscription(
        { priceId },
        {
          onSuccess: async () => {
            await currentUser?.refresh();
            await queryUtils.subscriptions.getUserSubscription.reset();
            onSuccess?.();
            return Router.push('/user/membership?updated=true');
          },
          onError: (error) => {
            showErrorNotification({
              title: 'Sorry, there was an error while trying to subscribe. Please try again later',
              error: new Error(error.message),
            });
          },
        }
      );
    } else {
      let customerId = currentUser?.paddleCustomerId;

      if (!currentUser?.paddleCustomerId) {
        // If this ever happens, first, create the customer id:
        customerId = await getOrCreateCustomer();
      }

      if (hasPaddleSubscription) {
        await refreshSubscription();

        showErrorNotification({
          title: 'You already have an active subscription',
          error: new Error(
            'We detected an existing subscription in our payment provider. We have refreshed your subscription status. Please reload the page and try again if you wish to update your subscription. If you continue to see this message, please contact support.'
          ),
        });

        return;
      }

      paddle?.Checkout.open({
        items: [
          {
            priceId,
            quantity: 1,
          },
        ],
        customer: {
          id: customerId as string,
        },
        customData: {
          userId: currentUser?.id ?? 'N/A',
        },
      });
    }
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
    if (emitter) {
      emitter.on('checkout.completed', trackCheckout);
    }
    return () => {
      emitter?.off('checkout.completed', trackCheckout);
    };
  }, [emitter, trackCheckout]);

  return (
    <LoginPopover>
      {typeof children === 'function'
        ? children({
            onClick: handleClick,
            loading: isLoading,
            disabled:
              (!isLoading && mutateCount > 0) ||
              subscriptionLoading ||
              disabled ||
              loadingPaddleSubscriptionStatus,
          })
        : cloneElement(children, {
            onClick: handleClick,
            loading: isLoading,
            disabled:
              (!isLoading && mutateCount > 0) ||
              subscriptionLoading ||
              disabled ||
              loadingPaddleSubscriptionStatus,
          })}
    </LoginPopover>
  );
}

export function SubscribeButton({ children, priceId, onSuccess, disabled, forceProvider }: Props) {
  const currentUser = useCurrentUser();
  const paymentProvider = usePaymentProvider();
  const featureFlags = useFeatureFlags();
  const { subscriptionPaymentProvider } = useActiveSubscription();

  const provider = forceProvider ?? subscriptionPaymentProvider ?? paymentProvider;

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

  if (currentUser && !currentUser.email)
    return (
      <Button
        onClick={handleAddEmail}
        style={{ height: 50 }}
        disabled={featureFlags.disablePayments}
      >
        <Stack align="center" gap={0}>
          <Text align="center" style={{ lineHeight: 1.1 }}>
            Subscribe
          </Text>
          <Text align="center" size="xs" style={{ color: 'rgba(255,255,255,.7)' }}>
            *Email Required. Click here to set it.
          </Text>
        </Stack>
      </Button>
    );

  if (provider === PaymentProvider.Stripe) {
    return (
      <StripeSubscribeButton
        priceId={priceId}
        onSuccess={onSuccess}
        disabled={disabled || featureFlags.disablePayments}
      >
        {children}
      </StripeSubscribeButton>
    );
  }

  if (provider === PaymentProvider.Paddle) {
    // Default to Paddle:
    return (
      <PaddleSubscribeButton
        priceId={priceId}
        onSuccess={onSuccess}
        disabled={disabled || featureFlags.disablePayments}
      >
        {children}
      </PaddleSubscribeButton>
    );
  }

  if (provider === PaymentProvider.Civitai && featureFlags.prepaidMemberships) {
    // Default to Paddle:
    return (
      <Button component={Link} href="/gift-cards?type=memberships" radius="xl">
        Get Prepaid Membership
      </Button>
    );
  }

  return null;
}

type Props = {
  children:
    | React.ReactElement
    | ((props: {
        onClick: () => void;
        disabled?: boolean;
        loading: boolean;
      }) => React.ReactElement);
  priceId: string;
  onSuccess?: () => void;
  disabled?: boolean;
  forceProvider?: PaymentProvider;
};
