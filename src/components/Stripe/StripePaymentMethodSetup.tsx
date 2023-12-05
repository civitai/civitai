import { useStripePromise } from '~/providers/StripeProvider';
import { trpc } from '~/utils/trpc';
import { Elements, PaymentElement } from '@stripe/react-stripe-js';
import React from 'react';
import { useStripePaymentMethodSetup } from '~/components/Buzz/useStripePaymentMethodSetup';
import { StripeElementsOptions, StripePaymentElementOptions } from '@stripe/stripe-js';
import { Button, Center, Group, Loader, Stack, Text, useMantineTheme } from '@mantine/core';

export const StripePaymentMethodSetup = ({ ...props }: { redirectUrl?: string }) => {
  const stripePromise = useStripePromise();
  const theme = useMantineTheme();

  const { data, isLoading, isFetching } = trpc.stripe.getSetupIntent.useQuery(
    { paymentMethodTypes: undefined },
    { refetchOnMount: 'always', cacheTime: 0 }
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
      <SetupPaymentMethod {...props} />
    </Elements>
  );
};

const SetupPaymentMethod = ({ redirectUrl }: { redirectUrl?: string }) => {
  const { processingSetup, onConfirmSetup, errorMessage } = useStripePaymentMethodSetup({
    redirectUrl,
  });

  const paymentElementOptions: StripePaymentElementOptions = {
    layout: 'tabs',
  };

  const handleSubmit = () => {
    onConfirmSetup();
  };

  return (
    <form
      id="stripe-payment-form"
      onSubmit={async (e) => {
        e.preventDefault();
        handleSubmit();
      }}
    >
      <Stack spacing="md">
        <PaymentElement id="payment-element" options={paymentElementOptions} />
        {errorMessage && (
          <Text color="red" size="sm">
            {errorMessage}
          </Text>
        )}
        <Group position="right">
          <Button
            component="button"
            disabled={processingSetup}
            loading={processingSetup}
            type="submit"
          >
            {processingSetup ? 'Processing...' : `Add payment method`}
          </Button>
        </Group>
      </Stack>
    </form>
  );
};
