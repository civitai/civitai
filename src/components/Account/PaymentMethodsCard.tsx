import {
  Accordion,
  ActionIcon,
  Card,
  Center,
  Divider,
  Group,
  GroupProps,
  Loader,
  Stack,
  Text,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';

import React from 'react';
import { formatDate } from '~/utils/date-helpers';
import { useMutateStripe, useUserPaymentMethods } from '~/components/Stripe/stripe.utils';
import { IconCreditCard, IconCurrencyDollar, IconMoodDollar, IconTrash } from '@tabler/icons-react';
import { openConfirmModal } from '@mantine/modals';
import { StripePaymentMethodSetup } from '~/components/Stripe/StripePaymentMethodSetup';
import { UserPaymentMethod } from '~/types/router';
import { booleanString } from '~/utils/zod-helpers';
import { useRouter } from 'next/router';
import { z } from 'zod';

export const PaymentMethodItem = ({
  paymentMethod,
  children,
}: {
  paymentMethod: UserPaymentMethod;
  children?: React.ReactNode;
}) => {
  const { type } = paymentMethod;
  const groupProps: GroupProps = {
    position: 'apart',
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

          {children}
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

          {children}
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

          {children}
        </Group>
      );
    default:
      return (
        <Group {...groupProps}>
          <Stack spacing={0}>
            <Text size="xs" transform="capitalize" color="dimmed">
              {type.replace(/_/gi, ' ')}
            </Text>
            <Text size="sm">Created on: {formatDate(new Date(paymentMethod.created * 1000))}</Text>
          </Stack>

          {children}
        </Group>
      );
  }
};

const querySchema = z.object({
  missingPaymentMethod: booleanString().optional(),
});

export function PaymentMethodsCard() {
  const { deletingPaymentMethod, deletePaymentMethod } = useMutateStripe();
  const { userPaymentMethods, isLoading: isLoadingPaymentMethods } = useUserPaymentMethods();
  const router = useRouter();
  const result = querySchema.safeParse(router.query);

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
    <Card withBorder>
      <Stack>
        <Title order={2} id="payment-methods">
          Payment methods
        </Title>
        {result.success && result.data.missingPaymentMethod && (
          <Text color="red" size="sm">
            It looks like you are trying to upgrade your membership but we do not have a payment
            method setup for you. Please add one before attempting to upgrade.
          </Text>
        )}
        <Divider label="Your payment methods" />
        {isLoadingPaymentMethods ? (
          <Center>
            <Loader variant="bars" />
          </Center>
        ) : (userPaymentMethods?.length ?? 0) > 0 ? (
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

              return (
                <PaymentMethodItem key={paymentMethod.id} paymentMethod={paymentMethod}>
                  {deleteAction}
                </PaymentMethodItem>
              );
            })}
          </Stack>
        ) : (
          <Text align="center" color="dimmed" size="sm">
            &hellip;You have no payment methods added yet&hellip;
          </Text>
        )}
        <Divider mx="-md" />
        <Accordion variant="default" px={0}>
          <Accordion.Item value="paymentMethod">
            <Accordion.Control py={8} px={0}>
              <Group spacing={8}>
                <IconCreditCard size={24} />
                <Text size="lg" weight={700}>
                  Add new payment method
                </Text>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              {!isLoadingPaymentMethods && (
                <StripePaymentMethodSetup redirectUrl={'/user/account#payment-methods'} />
              )}
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </Stack>
    </Card>
  );
}
