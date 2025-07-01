import { Button, Group, Stack } from '@mantine/core';
import { IconCreditCard } from '@tabler/icons-react';
import { useMutateEmerchantPay, useEmerchantPayStatus } from '~/components/EmerchantPay/util';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

interface BuzzEmerchantPayButtonProps {
  disabled: boolean;
  unitAmount: number;
  buzzAmount: number;
}

export const BuzzEmerchantPayButton = ({
  unitAmount,
  buzzAmount,
  disabled,
}: BuzzEmerchantPayButtonProps) => {
  const features = useFeatureFlags();
  const { createBuzzOrder, creatingBuzzOrder } = useMutateEmerchantPay();
  const { isLoading: checkingHealth, healthy } = useEmerchantPayStatus();

  if (!features.emerchantpayPayments) {
    return null;
  }

  if (!checkingHealth && !healthy) {
    return null;
  }

  const handleClick = async () => {
    const data = await createBuzzOrder({
      unitAmount,
      buzzAmount,
    });

    if (data?.redirect_url) {
      window.location.replace(data.redirect_url);
    }
  };

  return (
    <Stack gap={0} align="center">
      <Button
        disabled={disabled || checkingHealth}
        loading={creatingBuzzOrder}
        onClick={handleClick}
        radius="xl"
        fullWidth
      >
        <Group gap="xs" wrap="nowrap">
          <IconCreditCard size={20} />
          <span>Credit/Debit Card</span>
        </Group>
      </Button>
    </Stack>
  );
};
