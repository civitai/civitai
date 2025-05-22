import {
  Button,
  Center,
  Group,
  Stack,
  Text,
  Divider,
  Loader,
  useMantineTheme,
  Title,
  useComputedColorScheme,
} from '@mantine/core';
import { Currency } from '~/shared/utils/prisma/enums';
import React, { useEffect, useMemo, useState } from 'react';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { Elements, PaymentElement } from '@stripe/react-stripe-js';
import type { StripeElementsOptions, StripePaymentElementOptions } from '@stripe/stripe-js';
import { useStripePromise } from '~/providers/StripeProvider';
import { useStripeTransaction } from '~/components/Buzz/useStripeTransaction';
import { formatPriceForDisplay } from '~/utils/number-helpers';
import { PaymentIntentMetadataSchema } from '~/server/schema/stripe.schema';
import { useTrackEvent } from '../TrackView/track.utils';
import { closeAllModals } from '@mantine/modals';
import { usePaymentIntent, useUserPaymentMethods } from '~/components/Stripe/stripe.utils';
import { PaymentMethodItem } from '~/components/Account/PaymentMethodsCard';
import { RecaptchaNotice } from '../Recaptcha/RecaptchaWidget';
import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';
import { IconAlertCircle } from '@tabler/icons-react';

const Error = ({ error, onClose }: { error: string; onClose: () => void }) => (
  <Stack>
    <Title order={3}>Whoops!</Title>
    <AlertWithIcon
      icon={<IconAlertCircle />}
      color="red"
      iconColor="red"
      title="Sorry, it looks like there was an error"
    >
      {error}
    </AlertWithIcon>

    <RecaptchaNotice />

    <Center>
      <Button onClick={onClose}>Close this window</Button>
    </Center>
  </Stack>
);

const StripeTransactionModal = ({
  unitAmount,
  currency,
  message,
  onSuccess,
  onClose,
  metadata,
  clientSecret,
  successMessage,
  paymentMethodTypes = [],
  setupFuturePayment,
  setupFuturePaymentToggle,
}: Props & { clientSecret: string; onClose: () => void; paymentMethodTypes?: string[] }) => {
  const { userPaymentMethods, isLoading: isLoadingPaymentMethods } = useUserPaymentMethods();
  const [success, setSuccess] = useState<boolean>(false);
  const supportedUserPaymentMethods = useMemo(() => {
    const available =
      userPaymentMethods?.filter((method) => paymentMethodTypes.includes(method.type)) ?? [];
    const deduped = [];
    const seen = new Set();
    for (const method of available) {
      const id = method.card?.last4 ?? method.id;
      if (seen.has(id)) continue;
      seen.add(id);
      deduped.push(method);
    }

    return deduped;
  }, [userPaymentMethods, paymentMethodTypes]);

  const { trackAction } = useTrackEvent();

  const { processingPayment, onConfirmPayment, errorMessage, paymentIntentStatus } =
    useStripeTransaction({
      clientSecret,
      onPaymentSuccess: async (stripePaymentIntent) => {
        await onSuccess?.(stripePaymentIntent.id);
        setSuccess(true);
      },
      metadata,
    });

  const paymentElementOptions: StripePaymentElementOptions = {
    layout: 'tabs',
  };

  const processingTooLong = paymentIntentStatus === 'processing_too_long';
  const successTransactionButError = paymentIntentStatus === 'success_with_error';

  if (success) {
    return (
      <Stack>
        <Group justify="space-between" wrap="nowrap">
          <Text size="lg" fw={700}>
            Complete your transaction
          </Text>
        </Group>
        <Divider mx="-lg" />
        {successMessage ? <>{successMessage}</> : <Text>Thank you for your purchase!</Text>}
        <Button
          onClick={() => {
            closeAllModals();
            onClose();
          }}
        >
          Close
        </Button>
      </Stack>
    );
  }

  if (successTransactionButError) {
    return (
      <Stack>
        <Group justify="space-between" wrap="nowrap">
          <Text size="lg" fw={700}>
            Complete your transaction
          </Text>
        </Group>
        <Divider mx="-lg" />
        <Text>
          Thank you, we have received your payment but something seems to have gone wrong. Please{' '}
          <Text component="span" fw="bold">
            DO NOT ATTEMPT TO PURCHASE AGAIN
          </Text>
          . If your Buzz is not delivered within the next few minutes, please contact support.
        </Text>
        <Button
          onClick={() => {
            closeAllModals();
            onClose();
          }}
        >
          Close
        </Button>
      </Stack>
    );
  }

  return (
    <form
      id="stripe-payment-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const paymentIntent = await onConfirmPayment();
        if (paymentIntent)
          trackAction({
            type: 'PurchaseFunds_Confirm',
            details: { ...metadata, method: paymentIntent.payment_method?.type },
          }).catch(() => undefined);
      }}
    >
      <Stack gap="md">
        <Group justify="space-between" wrap="nowrap">
          <Text size="lg" fw={700}>
            Complete your transaction
          </Text>
        </Group>
        <Divider mx="-lg" />
        {message && <>{message}</>}

        {(supportedUserPaymentMethods?.length ?? 0) > 0 && (
          <Stack>
            <Divider mx="-lg" />
            <Text fw="bold">Saved payment methods</Text>
            <Stack gap="sm">
              {supportedUserPaymentMethods.map((paymentMethod) => (
                <PaymentMethodItem key={paymentMethod.id} paymentMethod={paymentMethod}>
                  <Button
                    color="blue"
                    onClick={async () => {
                      const paymentIntent = await onConfirmPayment(paymentMethod.id);
                      trackAction({
                        type: 'PurchaseFunds_Confirm',
                        details: { ...metadata, method: paymentMethod.type },
                      }).catch(() => undefined);
                    }}
                    disabled={processingPayment || processingTooLong || successTransactionButError}
                    loading={processingPayment}
                  >
                    Pay ${formatPriceForDisplay(unitAmount, currency)}
                  </Button>
                </PaymentMethodItem>
              ))}
            </Stack>
            <Divider mx="-lg" />
            <Text fw="bold">Add new payment method</Text>
          </Stack>
        )}
        {setupFuturePayment && (
          <Text size="sm">
            Don&rsquo;t see your payment method?{' '}
            <Text c="blue.4" component="button" onClick={setupFuturePaymentToggle}>
              Click here
            </Text>
          </Text>
        )}
        {!setupFuturePayment && (
          <Text size="sm">
            <Text c="blue.4" component="button" onClick={setupFuturePaymentToggle}>
              Back to default payment methods
            </Text>
          </Text>
        )}
        <PaymentElement id="payment-element" options={paymentElementOptions} />
        {errorMessage && (
          <Text c="red" size="sm">
            {errorMessage}
          </Text>
        )}

        <RecaptchaNotice />

        <Group justify="flex-end">
          <Button
            variant="filled"
            color="gray"
            onClick={() => {
              trackAction({ type: 'PurchaseFunds_Cancel', details: { step: 2 } }).catch(
                () => undefined
              );
              onClose();
            }}
            disabled={processingPayment}
          >
            {processingTooLong || successTransactionButError ? 'Close' : 'Cancel'}
          </Button>
          <Button
            component="button"
            disabled={processingPayment || processingTooLong || successTransactionButError}
            loading={processingPayment}
            type="submit"
          >
            {processingPayment
              ? 'Processing...'
              : `Pay $${formatPriceForDisplay(unitAmount, currency)}`}
          </Button>
        </Group>
      </Stack>
    </form>
  );
};

type Props = {
  successMessage?: React.ReactNode;
  message?: React.ReactNode;
  unitAmount: number;
  currency?: Currency;
  onSuccess?: (stripePaymentIntentId: string) => Promise<void>;
  metadata: PaymentIntentMetadataSchema;
  paymentMethodTypes?: string[];
  setupFuturePayment?: boolean;
  setupFuturePaymentToggle?: () => void;
};

const { openModal, Modal } = createContextModal<Props>({
  name: 'stripeTransaction',
  withCloseButton: false,
  size: 'lg',
  radius: 'lg',
  closeOnEscape: false,
  closeOnClickOutside: false,
  zIndex: 400,
  Element: ({
    context,
    props: {
      unitAmount,
      currency = Currency.USD,
      metadata,
      paymentMethodTypes: desiredPaymentMethodTypes,
      ...props
    },
  }) => {
    const theme = useMantineTheme();
    const colorScheme = useComputedColorScheme('dark');
    const stripePromise = useStripePromise();

    const {
      clientSecret,
      paymentMethodTypes,
      isLoading,
      setupFuturePayment,
      setSetupFuturePayment,
      error,
    } = usePaymentIntent({
      currency,
      metadata,
      unitAmount,
      desiredPaymentMethodTypes,
    });

    const { isLoading: isLoadingPaymentMethods } = useUserPaymentMethods({
      enabled: !!clientSecret,
    });

    if (isLoading || (isLoadingPaymentMethods && !error)) {
      return (
        <Center>
          <Loader variant="bars" />
        </Center>
      );
    }

    const handleClose = () => {
      context.close();
    };

    if (error || !clientSecret) {
      return (
        <Error
          error={
            error ??
            'We are unable to connect you with Stripe services to perform a transaction. Please try again later.'
          }
          onClose={handleClose}
        />
      );
    }

    const options: StripeElementsOptions = {
      clientSecret,
      appearance: { theme: colorScheme === 'dark' ? 'night' : 'stripe' },
      locale: 'en',
    };

    return (
      <Elements stripe={stripePromise} key={clientSecret} options={options}>
        <StripeTransactionModal
          clientSecret={clientSecret}
          key={clientSecret}
          onClose={handleClose}
          unitAmount={unitAmount}
          currency={currency}
          metadata={metadata}
          // This is the payment methods we will end up supporting based off of
          // the payment intent instead of the ones we "wish" to support.
          paymentMethodTypes={paymentMethodTypes}
          setupFuturePayment={setupFuturePayment}
          setupFuturePaymentToggle={() => setSetupFuturePayment(!setupFuturePayment)}
          {...props}
        />
      </Elements>
    );
  },
});

export const openStripeTransactionModal = openModal;
export default Modal;
