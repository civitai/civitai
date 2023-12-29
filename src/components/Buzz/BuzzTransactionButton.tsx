import { Group, Text, ButtonProps, Button, Tooltip } from '@mantine/core';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import React from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '@prisma/client';
import { IconAlertTriangleFilled } from '@tabler/icons-react';
import { useBuzzTransaction } from './buzz.utils';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';

type Props = ButtonProps & {
  buzzAmount: number;
  message?: string | ((requiredBalance: number) => string);
  label: string;
  onPerformTransaction?: () => void;
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  performTransactionOnPurchase?: boolean;
};

export function BuzzTransactionButton({
  buzzAmount,
  onPerformTransaction,
  purchaseSuccessMessage,
  message = "You don't have enough funds. Buy or earn more buzz to perform this action",
  performTransactionOnPurchase = true,
  label,
  ...buttonProps
}: Props) {
  const features = useFeatureFlags();
  const { conditionalPerformTransaction, hasRequiredAmount } = useBuzzTransaction({
    message,
    purchaseSuccessMessage,
    performTransactionOnPurchase,
  });

  if (!features.buzz) return null;

  const onClick = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();

    if (!onPerformTransaction) {
      return;
    }

    if (!features.buzz) {
      // Just perform whatever it is we need
      onPerformTransaction();
      return;
    }

    conditionalPerformTransaction(buzzAmount, onPerformTransaction);
  };
  const hasCost = buzzAmount > 0;

  return (
    <Button
      color={hasCost ? 'yellow.7' : 'blue'}
      {...buttonProps}
      onClick={onPerformTransaction ? onClick : undefined}
    >
      <Group spacing="md" noWrap>
        {hasCost && (
          <CurrencyBadge
            currency={Currency.BUZZ}
            unitAmount={buzzAmount}
            displayCurrency={false}
            radius={buttonProps?.radius ?? 'sm'}
            px="xs"
          >
            {!hasRequiredAmount(buzzAmount) && (
              <Tooltip
                label="Insufficient buzz. Click to buy more"
                style={{ textTransform: 'capitalize' }}
                maw={250}
                multiline
                withArrow
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
        )}
        <Text>{label}</Text>
      </Group>
    </Button>
  );
}
