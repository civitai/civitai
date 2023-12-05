import {
  Button,
  Card,
  Center,
  Divider,
  Group,
  Loader,
  Select,
  Stack,
  Switch,
  Text,
  Title,
  useMantineTheme,
} from '@mantine/core';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { useStripePromise } from '~/providers/StripeProvider';
import { StripeElementsOptions, StripePaymentElementOptions } from '@stripe/stripe-js';
import React, { useState } from 'react';
import { Elements, PaymentElement } from '@stripe/react-stripe-js';
import { useStripePaymentMethodSetup } from '~/components/Buzz/useStripePaymentMethodSetup';
import { formatDate } from '~/utils/date-helpers';

export function PaymentMethodsCard({ ...props }: { redirectUrl?: string }) {
  const theme = useMantineTheme();
  const stripePromise = useStripePromise();

  const { data, isLoading, isFetching } = trpc.stripe.getSetupIntent.useQuery(
    { paymentMethodTypes: undefined },
    { refetchOnMount: 'always', cacheTime: 0 }
  );
  const { data: userPaymentMethods = [], isLoading: isLoadingPaymentMethods } =
    trpc.user.getPaymentMethods.useQuery();

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

  return (
    <Card withBorder id="settings">
      <Stack>
        <Title order={2}>Payment methhods</Title>
        <Divider label="Your payment methods" />
        {(userPaymentMethods?.length ?? 0) > 0 ? (
          <Stack>
            {userPaymentMethods.map((paymentMethod, index) => {
              const { type } = paymentMethod;
              switch (type) {
                case 'card':
                  return (
                    <Group key={paymentMethod.id}>
                      <Stack spacing={0}>
                        <Text size="xs" color="dimmed">
                          Card
                        </Text>
                        <Text size="sm">
                          <Text component="span" weight="bold" transform="capitalize">
                            {paymentMethod.card?.brand}
                          </Text>{' '}
                          ending in{' '}
                          <Text component="span" weight="bold">
                            {paymentMethod.card?.last4}
                          </Text>
                        </Text>
                      </Stack>
                    </Group>
                  );
                case 'sepa_debit':
                  return (
                    <Group key={paymentMethod.id}>
                      <Stack spacing={0}>
                        <Text size="xs" color="dimmed">
                          SEPA Debit
                        </Text>
                        <Text size="sm">
                          Ending in{' '}
                          <Text component="span" weight="bold">
                            {paymentMethod.sepa_debit?.last4}
                          </Text>
                        </Text>
                      </Stack>
                    </Group>
                  );
                case 'link':
                  return (
                    <Group key={paymentMethod.id}>
                      <Stack spacing={0}>
                        <Text size="xs" color="dimmed">
                          Link
                        </Text>
                        <Text size="sm">
                          Email:{' '}
                          <Text component="span" weight="bold">
                            {paymentMethod.link?.email}
                          </Text>
                        </Text>
                      </Stack>
                    </Group>
                  );
                default:
                  return (
                    <Group key={paymentMethod.id}>
                      <Stack spacing={0}>
                        <Text size="xs" transform="capitalize" color="dimmed">
                          {type.replace('_', ' ')}
                        </Text>
                        <Text size="sm">
                          Created on: {formatDate(new Date(paymentMethod.created * 1000))}
                        </Text>
                      </Stack>
                    </Group>
                  );
              }
            })}
          </Stack>
        ) : (
          <Text color="dimmed">User has no payment methods added yet.</Text>
        )}
        <Elements stripe={stripePromise} key={clientSecret} options={options}>
          <SetupPaymentMethod {...props} />
        </Elements>
      </Stack>
    </Card>
  );
}

const SetupPaymentMethod = ({ redirectUrl }: { redirectUrl?: string }) => {
  const [success, setSuccess] = useState<boolean>(false);

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
        <Group position="apart" noWrap>
          <Text size="lg" weight={700}>
            Add new payment method
          </Text>
        </Group>
        <Divider mx="-lg" />
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
