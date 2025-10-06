import { Button, Stack } from '@mantine/core';
import { IconCoinBitcoin } from '@tabler/icons-react';
import type { BuzzPurchaseImprovedProps } from '~/components/Buzz/BuzzPurchase/BuzzPurchaseImproved';
import { useMutateCoinbase, useCoinbaseStatus } from '~/components/Coinbase/util';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

export const BuzzCoinbaseButton = ({
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
  const { createBuzzOrder, creatingBuzzOrder } = useMutateCoinbase();
  const { isLoading: checkingHealth, healthy } = useCoinbaseStatus();
  const buzzConfig = useBuzzCurrencyConfig(buzzType);

  if (!checkingHealth && !healthy) {
    return null;
  }

  const handleClick = async () => {
    const data = await createBuzzOrder({
      unitAmount,
      buzzAmount,
    });

    if (data?.hosted_url) {
      window.location.replace(data.hosted_url);
    }
  };

  return (
    <Stack gap={0}>
      <Button
        disabled={disabled || creatingBuzzOrder}
        loading={creatingBuzzOrder}
        onClick={handleClick}
        size="md"
        radius="md"
        variant="light"
        color={buzzConfig.color}
        leftSection={<IconCoinBitcoin size={18} />}
        fw={500}
        fullWidth
      >
        Crypto
      </Button>
    </Stack>
  );
};
