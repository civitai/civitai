import { Box, Button, Stack, Text } from '@mantine/core';
import { FUNDING, PayPalButtons } from '@paypal/react-paypal-js';
import { useCallback, useMemo } from 'react';
import { BuzzPurchaseProps } from '~/components/Buzz/BuzzPurchase';
import { useMutateNowPayments, useNowPaymentsStatus } from '~/components/NowPayments/util';
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
  const { createPaymentInvoice, creatingPaymentInvoice } = useMutateNowPayments();
  const { isLoading, healthy } = useNowPaymentsStatus();

  if (isLoading || !healthy) {
    return null;
  }

  const handleClick = async () => {
    const data = await createPaymentInvoice({
      unitAmount,
      buzzAmount,
    });

    if (data.invoice_url) {
      // Open new screen so that the user can go ahead and pay.
      window.open(data.invoice_url, '_blank');
    }
  };

  // const crypto;

  return (
    <Button
      disabled={disabled}
      loading={creatingPaymentInvoice}
      onClick={handleClick}
      radius="xl"
      fullWidth
      color="grape"
    >
      Pay With Crypto{' '}
      {!!unitAmount
        ? `- $${formatCurrencyForDisplay(unitAmount, undefined, { decimals: false })}`
        : ''}
    </Button>
  );
};
