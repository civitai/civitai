import { Button, Group } from '@mantine/core';
import { IconCreditCard } from '@tabler/icons-react';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { PaymentIntentMetadataSchema } from '~/server/schema/stripe.schema';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

interface BuzzStripePaymentButtonProps {
  disabled: boolean;
  unitAmount: number;
  onValidate: () => boolean;
  buzzAmount: number;
  buzzType?: BuzzSpendType;
}

export function BuzzStripePaymentButton({
  disabled,
  unitAmount,
  onValidate,
  buzzAmount,
  buzzType,
}: BuzzStripePaymentButtonProps) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const buzzConfig = useBuzzCurrencyConfig(buzzType);

  const handleStripeSubmit = async () => {
    if (!onValidate()) {
      return;
    }

    if (!currentUser) {
      return;
    }

    const metadata: PaymentIntentMetadataSchema = {
      type: 'buzzPurchase',
      unitAmount,
      buzzAmount,
      userId: currentUser.id as number,
    };

    // openStripeTransactionModal(
    //   {
    //     unitAmount,
    //     message: (
    //       <Stack>
    //         <Text>
    //           You are about to purchase{' '}
    //           <CurrencyBadge currency={Currency.BUZZ} unitAmount={buzzAmount} />.
    //         </Text>
    //         <Text>Please fill in your data and complete your purchase.</Text>
    //       </Stack>
    //     ),
    //     successMessage,
    //     onSuccess: async (stripePaymentIntentId) => {
    //       // We do it here just in case, but the webhook should also do it
    //       await completeStripeBuzzPurchaseMutation({
    //         amount: buzzAmount,
    //         details: metadata,
    //         stripePaymentIntentId,
    //       });
    //     },
    //     metadata: metadata,
    //     // paymentMethodTypes: ['card'],
    //   },
    //   { fullScreen: isMobile }
    // );
  };

  return (
    <Button
      disabled={disabled || features.disablePayments}
      onClick={handleStripeSubmit}
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
