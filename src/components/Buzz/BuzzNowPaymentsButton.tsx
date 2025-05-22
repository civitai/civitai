import { Button, Stack, Text } from '@mantine/core';
import { BuzzPurchaseProps } from '~/components/Buzz/BuzzPurchase';
import { useMutateNowPayments, useNowPaymentsStatus } from '~/components/NowPayments/util';
import { NOW_PAYMENTS_FIXED_FEE } from '~/server/common/constants';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';

export const BuzzNowPaymentsButton = ({
  unitAmount,
  buzzAmount,
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
      window.location.replace(data.invoice_url);
    }
  };

  // const crypto;

  return (
    <Stack spacing={0} align="center">
      <Button
        disabled={disabled}
        loading={creatingPaymentInvoice}
        onClick={handleClick}
        radius="xl"
        fullWidth
        color="grape"
      >
        Pay with Crypto{' '}
        {!!unitAmount
          ? `- $${formatCurrencyForDisplay(unitAmount, undefined, { decimals: false })}`
          : ''}
      </Button>
      <Text size="xs" color="dimmed" mt={5}>
        A fixed fee of $
        {formatCurrencyForDisplay(NOW_PAYMENTS_FIXED_FEE, undefined, { decimals: true })} applies to
        Crypto payments.
      </Text>
    </Stack>
  );
};
