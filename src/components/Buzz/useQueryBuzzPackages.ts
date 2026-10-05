import { useState } from 'react';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const useQueryBuzzPackages = ({ onPurchaseSuccess }: { onPurchaseSuccess?: () => void }) => {
  const [processing, setProcessing] = useState<boolean>(false);
  const queryUtils = trpc.useUtils();

  const { data: packages = [], isLoading } = trpc.stripe.getBuzzPackages.useQuery();

  const { mutateAsync: completeStripeBuzzPurchaseMutation } =
    trpc.buzz.completeStripeBuzzPurchase.useMutation({
      async onSuccess() {
        await queryUtils.buzz.getBuzzAccount.invalidate();
        setProcessing(false);
        showSuccessNotification({
          title: 'Transaction completed successfully!',
          message: 'Your Buzz has been added to your account.',
        });
        onPurchaseSuccess?.();
      },
      onError(error) {
        showErrorNotification({
          title: 'There was an error while attempting to purchase Buzz. Please contact support.',
          error: new Error(error.message),
        });

        setProcessing(false);
      },
    });

  return {
    packages,
    isLoading,
    completeStripeBuzzPurchaseMutation,
    processing,
    setProcessing,
  };
};
