import { Button, Group, Stack, Text } from '@mantine/core';
import { IconCreditCard } from '@tabler/icons-react';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useMutatePaddle } from '~/components/Paddle/util';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import PaddleTransactionModal from '~/components/Paddle/PaddleTransacionModal';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { Currency } from '~/shared/utils/prisma/enums';
import { useCallback } from 'react';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

interface BuzzPaddlePaymentButtonProps {
  disabled: boolean;
  unitAmount: number;
  buzzAmount: number;
  onPurchaseSuccess?: () => void;
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  buzzType?: BuzzSpendType;
}

export function BuzzPaddlePaymentButton({
  disabled,
  unitAmount,
  buzzAmount,
  onPurchaseSuccess,
  purchaseSuccessMessage,
  buzzType,
}: BuzzPaddlePaymentButtonProps) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const { processCompleteBuzzTransaction } = useMutatePaddle();
  const buzzConfig = useBuzzCurrencyConfig(buzzType);

  const handlePaddleSubmit = useCallback(async () => {
    if (!currentUser) return;
    dialogStore.trigger({
      component: PaddleTransactionModal,
      props: {
        unitAmount,
        currency: 'USD',
        message: (
          <Stack>
            <Text>
              You are about to purchase{' '}
              <CurrencyBadge currency={Currency.BUZZ} unitAmount={buzzAmount} />
            </Text>
            <Text>Please fill in your data and complete your purchase.</Text>
          </Stack>
        ),
        successMessage: purchaseSuccessMessage ? (
          purchaseSuccessMessage(buzzAmount)
        ) : (
          <Stack>
            <Text>Thank you for your purchase!</Text>
            <Text>Purchased Buzz has been credited to your account.</Text>
          </Stack>
        ),
        onSuccess: async (transactionId: string) => {
          await processCompleteBuzzTransaction({ id: transactionId });
          onPurchaseSuccess?.();
        },
      },
    });
  }, [
    unitAmount,
    buzzAmount,
    onPurchaseSuccess,
    purchaseSuccessMessage,
    currentUser,
    processCompleteBuzzTransaction,
  ]);

  return (
    <Button
      disabled={disabled || features.disablePayments}
      onClick={handlePaddleSubmit}
      radius="xl"
      color={buzzConfig.color}
    >
      {features.disablePayments ? (
        <Group gap="xs" wrap="nowrap">
          <IconCreditCard size={20} />
          <span>Credit Card</span>
        </Group>
      ) : (
        <>
          Pay Now{' '}
          {!!unitAmount
            ? `- $${formatCurrencyForDisplay(unitAmount, undefined, { decimals: false })}`
            : ''}
        </>
      )}
    </Button>
  );
}
