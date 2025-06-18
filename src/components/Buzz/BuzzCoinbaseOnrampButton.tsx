import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { IconCreditCard, IconCreditCardFilled, IconMoodSad } from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
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
  type = 'default',
}: Pick<BuzzPurchaseProps, 'onPurchaseSuccess' | 'purchaseSuccessMessage'> & {
  disabled: boolean;
  unitAmount: number;
  buzzAmount: number;
  type?: 'default' | 'international';
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
          title: type === 'default' ? 'Purchasing with Debit Card' : 'Purchasing with Credit Card',
          type: 'info',
          icon: null,
          children: ({ handleClose }) => (
            <div className="flex w-full flex-col gap-4">
              {type === 'default' && (
                <p>
                  By continuing, you’ll be taken to a secure Coinbase page where you enter your card
                  details and buy a digital dollar (USDC). Once that purchase is complete,
                  you&rsquo;ll be sent right back to Civitai and we will use that digital dollar to
                  buy your Buzz credits for you. Your Buzz will arrive in your account in about 30
                  seconds.
                </p>
              )}
              {type === 'international' && (
                <>
                  <AlertWithIcon icon={<IconMoodSad size={20} />}>
                    <p>
                      We know this process isn&rsquo;t easy and we&rsquo;re continuing to pursue
                      standard payment processing.
                    </p>
                  </AlertWithIcon>
                  <p>
                    By continuing, you’ll be taken to a secure Coinbase page where you will need to
                    sign in or create a free account. After setting up your account, choose a credit
                    card (or another available method), enter your details, and complete your
                    purchase of digital dollars (USDC). Once that purchase is complete, you’ll be
                    sent right back to Civitai and we will use that digital dollar to buy Buzz for
                    you. Your Buzz will arrive in your account in about 30 seconds.
                  </p>
                </>
              )}

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
          {type === 'default' ? (
            <>
              <IconCreditCardFilled size={20} />
              <span>Debit Card (US Only)</span>
            </>
          ) : (
            <>
              <IconCreditCard size={20} />
              <span>Credit Card (International, Coinbase)</span>
            </>
          )}
        </Group>
      </Button>
    </Stack>
  );
};
