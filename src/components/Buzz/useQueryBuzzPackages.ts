import { useRouter } from 'next/router';
import { useState } from 'react';
import type { CreateBuzzSessionInput } from '~/server/schema/stripe.schema';
import { getClientStripe } from '~/utils/get-client-stripe';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const useQueryBuzzPackages = ({ onPurchaseSuccess }: { onPurchaseSuccess?: () => void }) => {
  const router = useRouter();
  const [processing, setProcessing] = useState<boolean>(false);
  const queryUtils = trpc.useUtils();

  const { data: packages = [], isLoading } = trpc.stripe.getBuzzPackages.useQuery();

  const createBuzzSessionMutation = trpc.stripe.createBuzzSession.useMutation({
    onSuccess: async ({ url, sessionId }) => {
      if (url) await router.push(url);
      else {
        const stripe = await getClientStripe();
        if (!stripe) {
          return;
        }

        await stripe.redirectToCheckout({ sessionId });
      }
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Could not process purchase',
        error: new Error(error.message),
      });
    },
  });

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

  const createCheckoutSession = (data: CreateBuzzSessionInput) => {
    return createBuzzSessionMutation.mutateAsync(data);
  };

  return {
    packages,
    isLoading,
    createCheckoutSession,
    completeStripeBuzzPurchaseMutation,
    processing,
    setProcessing,
  };
};
