import { Button, Stack } from '@mantine/core';
import { IconCreditCard } from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import type { BuzzPurchaseProps } from '~/components/Buzz/BuzzPurchase';
import { useMutateZkp2p } from '~/components/ZKP2P/util';
import AlertDialog from '~/components/Dialog/Common/AlertDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { IconInfoCircle } from '@tabler/icons-react';

export const BuzzZkp2pOnrampButton = ({
  unitAmount,
  buzzAmount,
  disabled,
}: Pick<BuzzPurchaseProps, 'onPurchaseSuccess' | 'purchaseSuccessMessage'> & {
  disabled: boolean;
  unitAmount: number;
  buzzAmount: number;
}) => {
  const { createBuzzOrderOnramp, creatingBuzzOrderOnramp } = useMutateZkp2p();

  const handleClick = async () => {
    const data = await createBuzzOrderOnramp({
      unitAmount,
      buzzAmount,
    });

    if (data?.url) {
      dialogStore.trigger({
        component: AlertDialog,
        props: {
          title: 'Purchasing with ZKP2P',
          type: 'info',
          icon: null,
          children: ({ handleClose }) => (
            <div className="flex w-full flex-col gap-4">
              <AlertWithIcon icon={<IconInfoCircle size={20} />}>
                <p>
                  ZKP2P is a privacy-focused payment method using USDC on the Base blockchain with
                  enhanced privacy.
                </p>
              </AlertWithIcon>
              <p>
                By continuing, you&apos;ll be taken to ZKP2P where you can complete your payment
                using USDC. The transaction will be processed privately and securely. Once payment
                is confirmed, you&apos;ll be redirected back to Civitai and your Buzz will be added
                to your account.
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
                  Continue to ZKP2P
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
        disabled={disabled}
        loading={creatingBuzzOrderOnramp}
        onClick={handleClick}
        size="md"
        radius="md"
        variant="light"
        color="blue"
        leftSection={<IconCreditCard size={16} />}
        fw={500}
        fullWidth
      >
        ZKP2P (Private USDC)
      </Button>
    </Stack>
  );
};
