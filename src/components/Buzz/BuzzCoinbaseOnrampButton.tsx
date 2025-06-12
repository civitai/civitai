import { Button, Group, Stack, Text } from '@mantine/core';
import { IconCreditCard } from '@tabler/icons-react';
import type { BuzzPurchaseProps } from '~/components/Buzz/BuzzPurchase';
import { useMutateCoinbase, useCoinbaseStatus } from '~/components/Coinbase/util';
import AlertDialog from '~/components/Dialog/Common/AlertDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { COINBASE_FIXED_FEE } from '~/server/common/constants';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';

export const BuzzCoinbaseOnrampButton = ({
  unitAmount,
  buzzAmount,
  disabled,
}: Pick<BuzzPurchaseProps, 'onPurchaseSuccess' | 'purchaseSuccessMessage'> & {
  disabled: boolean;
  unitAmount: number;
  buzzAmount: number;
}) => {
  const { createBuzzOrderOnramp, creatingBuzzOrderOnramp } = useMutateCoinbase();
  const { isLoading: checkingHealth, healthy } = useCoinbaseStatus();

  if (!checkingHealth && !healthy) {
    return null;
  }

  const handleClick = async () => {
    const data = await createBuzzOrderOnramp({
      unitAmount,
      buzzAmount,
    });

    if (data?.url) {
      dialogStore.trigger({
        component: AlertDialog,
        props: {
          title: 'Purchasing with Debit Card',
          type: 'info',
          icon: null,
          children: ({ handleClose }) => (
            <div className="flex w-full flex-col gap-4">
              <p>
                By continuing, you’ll be taken to a secure Coinbase page where you enter your card
                details and buy a digital dollar (USDC). Once that purchase is complete,
                you&rsquo;ll be sent right back to Civitai and we will use that digital dollar to
                buy your Buzz credits for you. Your Buzz will arrive in your account in about 30
                seconds.
              </p>

              <div className="flex flex-col gap-2">
                <Button
                  onClick={() => {
                    window.location.replace(data.url);
                  }}
                  size="sm"
                  compact
                  radius="xl"
                >
                  Continue to purchase
                </Button>
                <Button size="sm" compact radius="xl" variant="subtle" onClick={handleClose}>
                  Close
                </Button>
              </div>
            </div>
          ),
        },
      });
    }
  };

  return (
    <Stack gap={0} align="center">
      <Button
        disabled={disabled || checkingHealth}
        loading={creatingBuzzOrderOnramp}
        onClick={handleClick}
        radius="xl"
        fullWidth
      >
        <Group gap="xs" wrap="nowrap">
          <IconCreditCard size={20} />
          <span>Debit Card</span>
        </Group>
      </Button>
    </Stack>
  );
};
