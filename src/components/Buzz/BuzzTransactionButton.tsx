import {
  Button,
  ButtonProps,
  createStyles,
  Group,
  MantineSize,
  Text,
  Tooltip,
} from '@mantine/core';
import { Currency } from '@prisma/client';
import { IconAlertTriangleFilled } from '@tabler/icons-react';
import React from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useBuzzTransaction } from './buzz.utils';

type Props = ButtonProps & {
  buzzAmount: number;
  message?: string | ((requiredBalance: number) => string);
  label: string;
  onPerformTransaction?: () => void;
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  size?: MantineSize;
  performTransactionOnPurchase?: boolean;
};

const useButtonStyle = createStyles((theme) => ({
  button: {
    paddingRight: 8,
    color: theme.colors.dark[8],
    fontWeight: 600,
  },
}));

export function BuzzTransactionButton({
  buzzAmount,
  onPerformTransaction,
  purchaseSuccessMessage,
  message = "You don't have enough funds. Buy or earn more buzz to perform this action",
  performTransactionOnPurchase = true,
  label,
  size,
  ...buttonProps
}: Props) {
  const features = useFeatureFlags();
  const { classes, cx } = useButtonStyle();
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
      className={cx(classes.button, buttonProps?.className)}
    >
      <Group spacing="md" noWrap position="apart">
        <Text size={size ?? 14}>{label}</Text>
        {hasCost && (
          <CurrencyBadge
            currency={Currency.BUZZ}
            unitAmount={buzzAmount}
            displayCurrency={false}
            radius={buttonProps?.radius ?? 'sm'}
            py={10}
            pl={4}
            pr={8}
            color="dark.8"
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
      </Group>
    </Button>
  );
}
