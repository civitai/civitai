import { Group, Text, ButtonProps, Button, Tooltip } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import React from 'react';
import { openBuyBuzzModal } from '~/components/Modals/BuyBuzzModal';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '@prisma/client';
import { IconAlertTriangleFilled } from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { useIsMobile } from '~/hooks/useIsMobile';

type Props = ButtonProps & {
  buzzAmount: number;
  message?: string | ((requiredBalance: number) => string);
  label: string;
  onPerformTransaction?: () => void;
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  performTransactionOnPurchase?: boolean;
};

export const useBuzzTransaction = ({
  message,
  purchaseSuccessMessage,
  performTransactionOnPurchase,
}: Pick<Props, 'message' | 'purchaseSuccessMessage' | 'performTransactionOnPurchase'>) => {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();
  const isMobile = useIsMobile();
  const createBuzzTransactionMutation = trpc.buzz.createTransaction.useMutation({
    async onSuccess(_, { amount }) {
      await queryUtils.buzz.getUserAccount.cancel();

      queryUtils.buzz.getUserAccount.setData(undefined, (old) =>
        old
          ? {
              ...old,
              balance: amount <= old.balance ? old.balance - amount : old.balance,
            }
          : old
      );
    },
    onError(error) {
      showErrorNotification({
        title: 'Error performing transaction',
        error: new Error(error.message),
      });
    },
  });

  const hasRequiredAmount = (buzzAmount: number) => (currentUser?.balance ?? 0) >= buzzAmount;
  const conditionalPerformTransaction = (buzzAmount: number, onPerformTransaction: () => void) => {
    if (!features.buzz) return onPerformTransaction();
    if (!currentUser?.balance || currentUser?.balance < buzzAmount) {
      openBuyBuzzModal(
        {
          message:
            typeof message === 'function'
              ? message(buzzAmount - (currentUser?.balance ?? 0))
              : message,
          minBuzzAmount: buzzAmount - (currentUser?.balance ?? 0),
          onPurchaseSuccess: performTransactionOnPurchase ? onPerformTransaction : undefined,
          purchaseSuccessMessage,
        },
        { fullScreen: isMobile }
      );

      return;
    }

    onPerformTransaction();
  };

  return {
    hasRequiredAmount,
    conditionalPerformTransaction,
    createBuzzTransactionMutation,
  };
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

  return (
    <Button color="yellow.7" {...buttonProps} onClick={onPerformTransaction ? onClick : undefined}>
      <Group spacing="md" noWrap>
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
        <Text>{label}</Text>
      </Group>
    </Button>
  );
}
