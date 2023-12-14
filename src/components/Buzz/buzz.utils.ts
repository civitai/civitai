import { useRouter } from 'next/router';
import React, { useState } from 'react';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { openBuyBuzzModal } from '~/components/Modals/BuyBuzzModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { CreateBuzzSessionInput } from '~/server/schema/stripe.schema';
import { getClientStripe } from '~/utils/get-client-stripe';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { useTrackEvent } from '../TrackView/track.utils';

export const useQueryBuzzPackages = ({ onPurchaseSuccess }: { onPurchaseSuccess?: () => void }) => {
  const router = useRouter();
  const [processing, setProcessing] = useState<boolean>(false);
  const queryUtils = trpc.useContext();

  const { data: packages = [], isLoading } = trpc.stripe.getBuzzPackages.useQuery();

  const createBuzzSessionMutation = trpc.stripe.createBuzzSession.useMutation({
    onSuccess: async ({ url, sessionId }) => {
      if (url) await router.push(url);
      else {
        const stripe = await getClientStripe();
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
          title: 'There was an error while attempting to purchase buzz. Please contact support.',
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

export const useBuzzTransaction = (opts?: {
  message?: string | ((requiredBalance: number) => string);
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  performTransactionOnPurchase?: boolean;
}) => {
  const { message, purchaseSuccessMessage, performTransactionOnPurchase } = opts ?? {};

  const features = useFeatureFlags();
  const { balance } = useBuzz();
  const isMobile = useIsMobile();

  const { trackAction } = useTrackEvent();

  const tipUserMutation = trpc.buzz.tipUser.useMutation({
    onError(error) {
      showErrorNotification({
        title: 'Error tipping user',
        error: new Error(error.message),
      });
    },
  });
  const hasRequiredAmount = (buzzAmount: number) => balance >= buzzAmount;
  const conditionalPerformTransaction = (buzzAmount: number, onPerformTransaction: () => void) => {
    if (!features.buzz) return onPerformTransaction();

    const hasRequiredAmount = balance >= buzzAmount;
    if (!hasRequiredAmount) {
      trackAction({ type: 'NotEnoughFunds', details: { amount: buzzAmount } }).catch(
        () => undefined
      );

      openBuyBuzzModal(
        {
          message: typeof message === 'function' ? message(buzzAmount - balance) : message,
          minBuzzAmount: buzzAmount - balance,
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
    tipUserMutation,
  };
};
