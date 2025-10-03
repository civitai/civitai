import { Button, Group, Stack } from '@mantine/core';
import { IconCreditCard } from '@tabler/icons-react';
import { useMutateEmerchantPay, useEmerchantPayStatus } from '~/components/EmerchantPay/util';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showErrorNotification } from '~/utils/notifications';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

interface BuzzEmerchantPayButtonProps {
  disabled: boolean;
  unitAmount: number;
  buzzAmount: number;
  buzzType?: BuzzSpendType;
}

export const BuzzEmerchantPayButton = ({
  unitAmount,
  buzzAmount,
  disabled,
  buzzType,
}: BuzzEmerchantPayButtonProps) => {
  const features = useFeatureFlags();
  const { createBuzzOrder, creatingBuzzOrder } = useMutateEmerchantPay();
  const { isLoading: checkingHealth, healthy } = useEmerchantPayStatus();
  const buzzConfig = useBuzzCurrencyConfig(buzzType);

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

    // Check if the response indicates an error
    if (data?.status === 'error' || data?.status === 'declined') {
      const errorMessage =
        data.message || data.technical_message || 'Unexpected error. Please try again.';
      showErrorNotification({
        title: 'Error while trying to create a payment link',
        error: new Error(errorMessage),
      });
      return;
    }

    if (data?.redirect_url) {
      window.location.replace(data.redirect_url);
    } else {
      showErrorNotification({
        title: 'Payment Setup Failed',
        error: new Error('No redirect URL received. Please try again.'),
      });
    }
  };

  return (
    <Stack gap={0} align="center">
      <Button
        disabled={disabled || checkingHealth}
        loading={creatingBuzzOrder}
        onClick={handleClick}
        size="md"
        radius="md"
        variant="light"
        color={buzzConfig.color}
        fw={500}
        fullWidth
      >
        <Group gap="xs" wrap="nowrap">
          <IconCreditCard size={18} />
          <span>Credit/Debit Card</span>
        </Group>
      </Button>
    </Stack>
  );
};
