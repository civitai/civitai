import { Box, Button, Stack, Text } from '@mantine/core';
import { FUNDING, PayPalButtons } from '@paypal/react-paypal-js';
import { useCallback, useMemo } from 'react';
import { BuzzPurchaseProps } from '~/components/Buzz/BuzzPurchase';
import { useNowPaymentsStatus } from '~/components/NowPayments/util';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { showSuccessNotification } from '~/utils/notifications';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

export const BuzzNowPaymentsButton = ({
  unitAmount,
  buzzAmount,
  onPurchaseSuccess,
  purchaseSuccessMessage,
  disabled,
}: Pick<BuzzPurchaseProps, 'onPurchaseSuccess' | 'purchaseSuccessMessage'> & {
  disabled: boolean;
  unitAmount: number;
  buzzAmount: number;
}) => {
  const currentUser = useCurrentUser();
  const isMobile = useIsMobile();

  const successMessage = useMemo(
    () =>
      purchaseSuccessMessage ? (
        purchaseSuccessMessage(buzzAmount)
      ) : (
        <Stack>
          <Text>Thank you for your purchase!</Text>
          <Text>Purchased Buzz has been credited to your account.</Text>
        </Stack>
      ),
    [buzzAmount, purchaseSuccessMessage]
  );

  const { isLoading, healthy, currencies } = useNowPaymentsStatus();

  console.log({ healthy, currencies });

  if (isLoading || !healthy || !currencies) {
    return null;
  }

  // const crypto;

  return (
    <Button disabled={disabled} onClick={undefined} radius="xl" fullWidth>
      Pay Now{' '}
      {!!unitAmount
        ? `- $${formatCurrencyForDisplay(unitAmount, undefined, { decimals: false })}`
        : ''}
    </Button>
  );
};
