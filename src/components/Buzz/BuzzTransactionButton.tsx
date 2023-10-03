import { Group, Text, ButtonProps, Button, Tooltip } from '@mantine/core';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import React from 'react';
import { openBuyBuzzModal } from '~/components/Modals/BuyBuzzModal';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '@prisma/client';
import { IconAlertTriangleFilled } from '@tabler/icons-react';

type Props = ButtonProps & {
  onPerformTransaction: () => void;
  buzzAmount: number;
  message?: string | ((requiredBalance: number) => string);
  label: string;
  purchaseSuccessMessage?: React.ReactNode;
  performTransactionOnPurchase?: boolean;
};

export function BuzzTransactionButton({
  buzzAmount,
  onPerformTransaction,
  purchaseSuccessMessage,
  message = "You don't have enough funds to perform this action.",
  performTransactionOnPurchase = true,
  label,
  ...buttonProps
}: Props) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const hasRequiredAmount = (currentUser?.balance ?? 0) >= buzzAmount;

  if (!features.buzz) return null;

  const onClick = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();

    if (!features.buzz) {
      // Just perform whatever it is we need
      onPerformTransaction();
      return;
    }

    if (!currentUser?.balance || currentUser?.balance < buzzAmount) {
      openBuyBuzzModal({
        message:
          typeof message === 'function'
            ? message(buzzAmount - (currentUser?.balance ?? 0))
            : message,
        minBuzzAmount: buzzAmount - (currentUser?.balance ?? 0),
        onPurchaseSuccess: performTransactionOnPurchase ? onPerformTransaction : undefined,
        purchaseSuccessMessage,
      });

      return;
    }

    onPerformTransaction();
  };

  return (
    <LoginPopover>
      <Button {...buttonProps} onClick={onClick}>
        <Group spacing="md" noWrap>
          <CurrencyBadge
            currency={Currency.BUZZ}
            unitAmount={buzzAmount}
            displayCurrency={false}
            radius={buttonProps?.radius ?? 'sm'}
            px="xs"
          >
            {!hasRequiredAmount && (
              <Tooltip
                label="Insufficient buzz. Click to buy more"
                style={{ textTransform: 'capitalize' }}
                withArrow
                maw={250}
              >
                <IconAlertTriangleFilled
                  color="red"
                  size={12}
                  fill="currentColor"
                  style={{ marginRight: 4 }}
                />
              </Tooltip>
            )}
          </CurrencyBadge>
          <Text>{label}</Text>
        </Group>
      </Button>
    </LoginPopover>
  );
}
