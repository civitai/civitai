import { Button, Group, Stack, Text } from '@mantine/core';
import { IconCoinBitcoin } from '@tabler/icons-react';
import type { BuzzPurchaseProps } from '~/components/Buzz/BuzzPurchase';
import { useMutateCoinbase, useCoinbaseStatus } from '~/components/Coinbase/util';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { COINBASE_FIXED_FEE } from '~/server/common/constants';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';

export const BuzzCoinbaseButton = ({
  unitAmount,
  buzzAmount,
  disabled,
}: Pick<BuzzPurchaseProps, 'onPurchaseSuccess' | 'purchaseSuccessMessage'> & {
  disabled: boolean;
  unitAmount: number;
  buzzAmount: number;
}) => {
  const features = useFeatureFlags();
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
    <Stack gap={0} align="center">
      <Button
        disabled={disabled || checkingHealth}
        loading={creatingBuzzOrder || creatingBuzzOrderOnramp}
        onClick={handleClick}
        radius="xl"
        fullWidth
      >
        <Group spacing="xs" noWrap>
          <IconCoinBitcoin size={20} />
          <span>Crypto</span>
        </Group>
      </Button>
    </Stack>
  );
};
