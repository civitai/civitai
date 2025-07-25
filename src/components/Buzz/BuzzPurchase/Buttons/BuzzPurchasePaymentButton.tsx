// This file previously contained a combined payment button for both Stripe and Paddle.
// It is now deprecated in favor of BuzzStripePaymentButton and BuzzPaddlePaymentButton.
// Please update any usage of BuzzPurchasePaymentButton to use the new components instead.

import { BuzzPaddlePaymentButton } from '~/components/Buzz/BuzzPurchase/Buttons/BuzzPaddlePaymentButton';
import { BuzzStripePaymentButton } from '~/components/Buzz/BuzzPurchase/Buttons/BuzzStripePaymentButton';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';

interface BuzzPurchasePaymentButtonProps {
  disabled: boolean;
  unitAmount: number;
  buzzAmount: number;
  onValidate: () => boolean;
  onPurchaseSuccess?: () => void;
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
}

export function BuzzPurchasePaymentButton({
  unitAmount,
  buzzAmount,
  onValidate,
  onPurchaseSuccess,
  purchaseSuccessMessage,
  disabled,
}: BuzzPurchasePaymentButtonProps) {
  const paymentProvider = usePaymentProvider();

  if (paymentProvider === 'Paddle') {
    return (
      <BuzzPaddlePaymentButton
        unitAmount={unitAmount}
        buzzAmount={buzzAmount}
        onPurchaseSuccess={onPurchaseSuccess}
        purchaseSuccessMessage={purchaseSuccessMessage}
        disabled={disabled}
      />
    );
  }

  if (paymentProvider === 'Stripe') {
    return (
      <BuzzStripePaymentButton
        unitAmount={unitAmount}
        buzzAmount={buzzAmount}
        onValidate={onValidate}
        disabled={disabled}
      />
    );
  }

  return null;
}
