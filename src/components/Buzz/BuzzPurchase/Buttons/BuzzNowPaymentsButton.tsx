import { Button, Stack, Text } from '@mantine/core';
import { IconCoinBitcoin } from '@tabler/icons-react';
import type { BuzzPurchaseImprovedProps } from '~/components/Buzz/BuzzPurchase/BuzzPurchaseImproved';
import { useMutateNowPayments, useNowPaymentsStatus } from '~/components/NowPayments/util';
import { NOW_PAYMENTS_FIXED_FEE } from '~/server/common/constants';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

export const BuzzNowPaymentsButton = ({
  unitAmount,
  buzzAmount,
  disabled,
  buzzType,
}: Pick<BuzzPurchaseImprovedProps, 'onPurchaseSuccess' | 'purchaseSuccessMessage'> & {
  disabled: boolean;
  unitAmount: number;
  buzzAmount: number;
  buzzType?: BuzzSpendType;
}) => {
  const { createPaymentInvoice, creatingPaymentInvoice } = useMutateNowPayments();
  const { isLoading, healthy } = useNowPaymentsStatus();
  const buzzConfig = useBuzzCurrencyConfig(buzzType);

  if (!isLoading && !healthy) {
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
    <Stack gap={0} align="center">
      <Button
        disabled={disabled || isLoading}
        loading={creatingPaymentInvoice}
        onClick={handleClick}
        size="md"
        radius="md"
        variant="light"
        color={buzzConfig.color}
        leftSection={<IconCoinBitcoin size={18} />}
        fw={500}
        fullWidth
      >
        Pay with Crypto{' '}
        {!!unitAmount
          ? `- $${formatCurrencyForDisplay(unitAmount + NOW_PAYMENTS_FIXED_FEE, undefined, {
              decimals: false,
            })}`
          : ''}
      </Button>
      {NOW_PAYMENTS_FIXED_FEE > 0 && (
        <Text size="xs" c="dimmed" mt={8}>
          Crypto purchases include a $
          {formatCurrencyForDisplay(NOW_PAYMENTS_FIXED_FEE, undefined, { decimals: true })} fee to
          cover network expenses.
        </Text>
      )}
    </Stack>
  );
};
