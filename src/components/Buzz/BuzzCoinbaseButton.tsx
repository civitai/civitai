import { Button, Stack, Text } from '@mantine/core';
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
  const { createBuzzOrder, creatingBuzzOrder, createBuzzOrderOnramp, creatingBuzzOrderOnramp } =
    useMutateCoinbase();
  const { isLoading: checkingHealth, healthy } = useCoinbaseStatus();

  if (!checkingHealth && !healthy) {
    return null;
  }

  const handleClick = async () => {
    if (features.coinbaseOnramp) {
      const data = await createBuzzOrderOnramp({
        unitAmount,
        buzzAmount,
      });

      if (data?.url) {
        window.location.replace(data.url);
      }
    } else {
      const data = await createBuzzOrder({
        unitAmount,
        buzzAmount,
      });

      if (data?.hosted_url) {
        window.location.replace(data.hosted_url);
      }
    }
  };

  return (
    <Stack spacing={0} align="center">
      <Button
        disabled={disabled || checkingHealth}
        loading={creatingBuzzOrder || creatingBuzzOrderOnramp}
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
