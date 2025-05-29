import { Anchor, Button, Stack, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
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
  const { createBuzzOrder, creatingBuzzOrder } = useMutateCoinbase();
  const { isLoading, healthy } = useCoinbaseStatus();

  if (!isLoading && !healthy) {
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
        disabled={disabled || isLoading}
        loading={creatingBuzzOrder}
        onClick={handleClick}
        radius="xl"
        fullWidth
        color="teal"
      >
        Pay with {features.nowpaymentPayments ? 'Coinbase' : 'Crypto'}{' '}
        {!!unitAmount
          ? `- $${formatCurrencyForDisplay(unitAmount + COINBASE_FIXED_FEE, undefined, {
              decimals: false,
            })}`
          : ''}
      </Button>
      {COINBASE_FIXED_FEE > 0 && (
        <Text size="xs" color="dimmed" mt={8}>
          Crypto purchases include a $
          {formatCurrencyForDisplay(COINBASE_FIXED_FEE, undefined, { decimals: true })} fee to cover
          network expenses.
        </Text>
      )}
    </Stack>
  );
};
