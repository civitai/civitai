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
import React from 'react';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { Elements, PaymentElement } from '@stripe/react-stripe-js';
import { StripeElementsOptions, StripePaymentElementOptions } from '@stripe/stripe-js';
import { StripeProvider, useStripePromise } from '~/providers/StripeProvider';
import { useStripeTransaction } from '~/components/Buzz/useStripeTransaction';
import { formatPriceForDisplay } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

type Props = {
  message?: React.ReactNode;
  unitAmount: number;
  currency?: Currency;
  onSuccess?: () => void;
  metadata?: any;
};

const { openModal, Modal } = createContextModal<Props>({
  name: 'stripeTransaction',
  withCloseButton: false,
  size: 'lg',
  radius: 'lg',
  Element: ({
    context,
    props: { message, unitAmount, currency = Currency.USD, metadata = {}, onSuccess },
  }) => {
    const theme = useMantineTheme();
    const stripePromise = useStripePromise();
    const { data, isLoading, isFetching } = trpc.stripe.getPaymentIntent.useQuery(
      { unitAmount, currency, metadata },
      { enabled: !!unitAmount && !!currency, refetchOnMount: 'always', cacheTime: 0 }
    );

    const clientSecret = data?.clientSecret;

    if (isLoading || isFetching) {
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

    return (
      <Elements stripe={stripePromise} key={clientSecret} options={options}>
        <StripeTransactionModal
          clientSecret={clientSecret}
          message={message}
          unitAmount={unitAmount}
          currency={currency}
          onClose={() => context.close()}
          metadata={metadata}
          onSuccess={onSuccess}
          key={clientSecret}
        />
      </Elements>
    );
  },
});

const StripeTransactionModal = ({
  unitAmount,
  currency,
  message,
  onSuccess,
  onClose,
  metadata,
  clientSecret,
}: Props & { clientSecret: string; onClose: () => void }) => {
  const { processingPayment, onConfirmPayment, errorMessage } = useStripeTransaction({
    clientSecret,
    onPaymentSuccess: () => {
      onSuccess?.();
      onClose();
    },
    metadata,
  });

  const paymentElementOptions: StripePaymentElementOptions = {
    layout: 'tabs',
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onConfirmPayment();
  };

  return (
    <form id="stripe-payment-form" onSubmit={handleSubmit}>
      <Stack spacing="md">
        <Group position="apart" noWrap>
          <Text size="lg" weight={700}>
            Complete your transaction
          </Text>
        </Group>
        <Divider mx="-lg" />
        {message && <>{message}</>}
        <PaymentElement id="payment-element" options={paymentElementOptions} />
        {errorMessage && (
          <Text color="red" size="sm">
            {errorMessage}
          </Text>
        )}
        <Group position="right">
          <Button variant="filled" color="gray" onClick={onClose} disabled={processingPayment}>
            Cancel
          </Button>
          <Button
            component="button"
            disabled={processingPayment}
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

export const openStripeTransactionModal = openModal;
export default Modal;
