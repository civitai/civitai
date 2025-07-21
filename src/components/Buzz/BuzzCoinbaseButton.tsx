import { Button, Stack } from '@mantine/core';
import { IconCoinBitcoin } from '@tabler/icons-react';
import type { BuzzPurchaseProps } from '~/components/Buzz/BuzzPurchase';
import { useMutateCoinbase, useCoinbaseStatus } from '~/components/Coinbase/util';

export const BuzzCoinbaseButton = ({
  unitAmount,
  buzzAmount,
  disabled,
}: Pick<BuzzPurchaseProps, 'onPurchaseSuccess' | 'purchaseSuccessMessage'> & {
  disabled: boolean;
  unitAmount: number;
  buzzAmount: number;
}) => {
  const { createBuzzOrder, creatingBuzzOrder, creatingBuzzOrderOnramp } = useMutateCoinbase();
  const { isLoading: checkingHealth, healthy } = useCoinbaseStatus();

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
        disabled={disabled || creatingBuzzOrder || creatingBuzzOrderOnramp}
        loading={creatingBuzzOrder || creatingBuzzOrderOnramp}
        onClick={handleClick}
        size="md"
        radius="md"
        variant="light"
        color="yellow"
        leftSection={<IconCoinBitcoin size={16} />}
        fw={500}
        fullWidth
      >
        Pay with Crypto
      </Button>
    </Stack>
  );
};
