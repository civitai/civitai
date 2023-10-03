import {
  Group,
  Popover,
  Text,
  UnstyledButton,
  UnstyledButtonProps,
  useMantineTheme,
} from '@mantine/core';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import React from 'react';
import { openBuyBuzzModal } from '~/components/Modals/BuyBuzzModal';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '@prisma/client';

type Props = UnstyledButtonProps & {
  onPerformTransaction: () => void;
  buzzAmount: number;
  message?: string | ((requiredBalance: number) => string);
  label: string;
};

export const useBuzzTransaction = () => {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const wrappedOnClick =
    ({
      onPerformTransaction,
      buzzAmount,
      message = (requiredBalance: number) =>
        `You require ${requiredBalance} more BUZZ to perform this action.`,
    }: Pick<Props, 'buzzAmount' | 'message' | 'onPerformTransaction'>) =>
    (e?: React.MouseEvent) => {
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
          onBuzzPurchased: onPerformTransaction,
        });

        return;
      }

      onPerformTransaction();
    };

  return wrappedOnClick;
};

export function BuzzTransactionButton({
  buzzAmount,
  onPerformTransaction,
  message = "You don't have enough funds to perform this action.",
  label,
  ...buttonProps
}: Props) {
  const features = useFeatureFlags();
  const onClickWrapper = useBuzzTransaction();

  if (!features.buzz) return null;

  return (
    <LoginPopover>
      <UnstyledButton
        {...buttonProps}
        onClick={onClickWrapper({ onPerformTransaction, buzzAmount, message })}
      >
        <Group spacing={4} noWrap>
          <CurrencyBadge currency={Currency.BUZZ} unitAmount={buzzAmount} />
          <Text>{label}</Text>
        </Group>
      </UnstyledButton>
    </LoginPopover>
  );
}
