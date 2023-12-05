import {
  ActionIcon,
  Button,
  Card,
  Center,
  Divider,
  Group,
  GroupProps,
  Loader,
  Select,
  Stack,
  Switch,
  Text,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';

import { trpc } from '~/utils/trpc';
import { useStripePromise } from '~/providers/StripeProvider';
import { StripeElementsOptions, StripePaymentElementOptions } from '@stripe/stripe-js';
import React, { useState } from 'react';
import { Elements, PaymentElement } from '@stripe/react-stripe-js';
import { useStripePaymentMethodSetup } from '~/components/Buzz/useStripePaymentMethodSetup';
import { formatDate } from '~/utils/date-helpers';
import { useMutateStripe, useUserPaymentMethods } from '~/components/Stripe/stripe.utils';
import { IconTrash } from '@tabler/icons-react';
import { openConfirmModal } from '@mantine/modals';

export function PaymentMethodsCard({ ...props }: { redirectUrl?: string }) {
  const theme = useMantineTheme();
  const stripePromise = useStripePromise();

  const { data, isLoading, isFetching } = trpc.stripe.getSetupIntent.useQuery(
    { paymentMethodTypes: undefined },
    { refetchOnMount: 'always', cacheTime: 0 }
  );

  const { deletingPaymentMethod, deletePaymentMethod } = useMutateStripe();

  const { userPaymentMethods, isLoading: isLoadingPaymentMethods } = useUserPaymentMethods();

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

  const handleDeletePaymentMethod = (paymentMethodId: string) => {
    openConfirmModal({
      title: 'Delete payment method',
      children: (
        <Stack>
          <Text>
            Are you sure you want to delete this payment method? This action is destructive.
          </Text>
          <Text size="xs" color="dimmed">
            If you have delete all your payment methods, your club memberships will be unable to be
            charged and you will lose access to those assets.
          </Text>
        </Stack>
      ),
      centered: true,
      labels: { confirm: 'Yes, delete', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        deletePaymentMethod({ paymentMethodId });
      },
    });
  };

  return (
    <Card withBorder id="settings">
      <Stack>
        <Title order={2}>Payment methods</Title>
        <Divider label="Your payment methods" />
        {(userPaymentMethods?.length ?? 0) > 0 ? (
          <Stack>
            {userPaymentMethods.map((paymentMethod, index) => {
              const { type } = paymentMethod;
              const deleteAction = (
                <Tooltip label="Delete payment method">
                  <ActionIcon
                    color="red"
                    onClick={() => handleDeletePaymentMethod(paymentMethod.id)}
                    loading={deletingPaymentMethod}
                    variant="outline"
                    size="md"
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Tooltip>
              );

              const groupProps: GroupProps = {
                position: 'apart',
                key: paymentMethod.id,
              };

              switch (type) {
                case 'card':
                  return (
                    <Group {...groupProps}>
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

                      {deleteAction}
                    </Group>
                  );
                case 'sepa_debit':
                  return (
                    <Group {...groupProps}>
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

                      {deleteAction}
                    </Group>
                  );
                case 'link':
                  return (
                    <Group {...groupProps}>
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

                      {deleteAction}
                    </Group>
                  );
                default:
                  return (
                    <Group {...groupProps}>
                      <Stack spacing={0}>
                        <Text size="xs" transform="capitalize" color="dimmed">
                          {type.replace('_', ' ')}
                        </Text>
                        <Text size="sm">
                          Created on: {formatDate(new Date(paymentMethod.created * 1000))}
                        </Text>
                      </Stack>

                      {deleteAction}
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
