import { Button, Group } from '@mantine/core';
import { IconCreditCard } from '@tabler/icons-react';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { PaymentIntentMetadataSchema } from '~/server/schema/stripe.schema';

interface BuzzStripePaymentButtonProps {
  disabled: boolean;
  unitAmount: number;
  onValidate: () => boolean;
  buzzAmount: number;
}

export function BuzzStripePaymentButton({
  disabled,
  unitAmount,
  onValidate,
  buzzAmount,
}: BuzzStripePaymentButtonProps) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();

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
