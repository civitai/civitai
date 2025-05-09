import {
  Accordion,
  ActionIcon,
  Button,
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
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { useMutatePaddle, useSubscriptionManagementUrls } from '~/components/Paddle/util';
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import { usePaddle } from '~/providers/PaddleProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export const PaymentMethodItem = ({
  paymentMethod,
  children,
}: {
  paymentMethod: UserPaymentMethod;
  children?: React.ReactNode;
}) => {
  const { type } = paymentMethod;
  const groupProps: GroupProps = {
    justify: 'space-between',
  };

  switch (type) {
    case 'card':
      return (
        <Group {...groupProps}>
          <Stack gap={0}>
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
          <Stack gap={0}>
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
          <Stack gap={0}>
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
          <Stack gap={0}>
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

const StripePaymentMethods = () => {
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
              <Group gap={8}>
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
};

const PaddlePaymentMethods = () => {
  const { managementUrls, isLoading } = useSubscriptionManagementUrls();
  const { paddle } = usePaddle();
  const currentUser = useCurrentUser();
  const { subscription } = useActiveSubscription();
  const { getOrCreateCustomer } = useMutatePaddle();

  if (!currentUser?.email) {
    return null;
  }

  const handleSetupDefaultPaymentMethod = async () => {
    let customerId = currentUser?.paddleCustomerId;

    if (!customerId) {
      // If this ever happens, first, create the customer id:
      customerId = await getOrCreateCustomer();
    }

    if (!!managementUrls?.freeSubscriptionPriceId) {
      paddle.Checkout.open({
        customer: {
          id: customerId,
        },
        customData: {
          userId: currentUser?.id,
        },
        items: [
          {
            priceId: managementUrls.freeSubscriptionPriceId,
            quantity: 1,
          },
        ],
      });
    }
  };

  if (!managementUrls?.updatePaymentMethod && !managementUrls?.freeSubscriptionPriceId) {
    return null;
  }

  return (
    <Card withBorder>
      <Stack>
        <Title order={2} id="payment-methods">
          Payment methods
        </Title>

        <Divider label="Your payment methods" />
        {isLoading && (
          <Center>
            <Loader variant="bars" />
          </Center>
        )}
        {managementUrls?.updatePaymentMethod && (
          <Button component="a" href={managementUrls?.updatePaymentMethod}>
            Update your default payment method
          </Button>
        )}
        {!managementUrls?.updatePaymentMethod && managementUrls?.freeSubscriptionPriceId && (
          <Stack>
            <Text align="center" size="sm" color="dimmed">
              We found no default payment method.
            </Text>
            <Button onClick={handleSetupDefaultPaymentMethod}>Setup default payment method</Button>
          </Stack>
        )}
      </Stack>
    </Card>
  );
};

export function PaymentMethodsCard() {
  const paymentProvider = usePaymentProvider();
  const { subscriptionLoading, subscriptionPaymentProvider } = useActiveSubscription();

  if (subscriptionLoading) {
    return null;
  }

  const currentPaymentProvider = subscriptionPaymentProvider ?? paymentProvider;

  if (currentPaymentProvider === PaymentProvider.Stripe) {
    return null; // We don't want new payment methods on stripe since we're leaving really.
  }

  if (currentPaymentProvider === PaymentProvider.Paddle) {
    return <PaddlePaymentMethods />;
  }

  return null;
}
