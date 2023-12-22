import {
  Button,
  Center,
  Group,
  Stack,
  Text,
  Divider,
  Loader,
  useMantineTheme,
} from '@mantine/core';
import { Currency } from '@prisma/client';
import React, { useState } from 'react';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { Elements, PaymentElement } from '@stripe/react-stripe-js';
import { StripeElementsOptions, StripePaymentElementOptions } from '@stripe/stripe-js';
import { useStripePromise } from '~/providers/StripeProvider';
import { useStripeTransaction } from '~/components/Buzz/useStripeTransaction';
import { formatPriceForDisplay } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { PaymentIntentMetadataSchema } from '~/server/schema/stripe.schema';
import { useTrackEvent } from '../TrackView/track.utils';
import { closeAllModals } from '@mantine/modals';
import { useUserPaymentMethods } from '~/components/Stripe/stripe.utils';
import { PaymentMethodItem } from '~/components/Account/PaymentMethodsCard';

const StripeTransactionModal = ({
  unitAmount,
  currency,
  message,
  onSuccess,
  onClose,
  metadata,
  clientSecret,
  successMessage,
}: Props & { clientSecret: string; onClose: () => void }) => {
  const { userPaymentMethods, isLoading: isLoadingPaymentMethods } = useUserPaymentMethods();
  const [success, setSuccess] = useState<boolean>(false);

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

  if (success) {
    return (
      <Stack>
        <Group position="apart" noWrap>
          <Text size="lg" weight={700}>
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
      <Stack spacing="md">
        <Group position="apart" noWrap>
          <Text size="lg" weight={700}>
            Complete your transaction
          </Text>
        </Group>
        <Divider mx="-lg" />
        {message && <>{message}</>}

        {(userPaymentMethods?.length ?? 0) > 0 && (
          <Stack>
            <Divider mx="-lg" />
            <Text weight="bold">Saved payment methods</Text>
            <Stack spacing="sm">
              {userPaymentMethods.map((paymentMethod) => (
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
                    disabled={processingPayment || processingTooLong}
                    loading={processingPayment}
                  >
                    Pay ${formatPriceForDisplay(unitAmount, currency)}
                  </Button>
                </PaymentMethodItem>
              ))}
            </Stack>
            <Divider mx="-lg" />
            <Text weight="bold">Add new payment method</Text>
          </Stack>
        )}
        <PaymentElement id="payment-element" options={paymentElementOptions} />
        {errorMessage && (
          <Text color="red" size="sm">
            {errorMessage}
          </Text>
        )}
        <Group position="right">
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
            {processingTooLong ? 'Close' : 'Cancel'}
          </Button>
          <Button
            component="button"
            disabled={processingPayment || processingTooLong}
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
    props: { unitAmount, currency = Currency.USD, metadata, paymentMethodTypes, ...props },
  }) => {
    const theme = useMantineTheme();
    const stripePromise = useStripePromise();
    const { isLoading: isLoadingPaymentMethods } = useUserPaymentMethods();

    const { data, isLoading, isFetching } = trpc.stripe.getPaymentIntent.useQuery(
      { unitAmount, currency, metadata, paymentMethodTypes },
      { enabled: !!unitAmount && !!currency, refetchOnMount: 'always', cacheTime: 0 }
    );

    const clientSecret = data?.clientSecret;

    if (isLoading || isFetching || isLoadingPaymentMethods) {
      return (
        <Center>
          <Loader variant="bars" />
        </Center>
      );
    }

    if (!clientSecret) {
      throw new Error('Failed to create client secret');
    }

    const options: StripeElementsOptions = {
      clientSecret,
      appearance: { theme: theme.colorScheme === 'dark' ? 'night' : 'stripe' },
    };

    const handleClose = () => {
      context.close();
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
          {...props}
        />
      </Elements>
    );
  },
});

export const openStripeTransactionModal = openModal;
export default Modal;
