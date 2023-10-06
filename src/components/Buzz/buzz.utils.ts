import { useRouter } from 'next/router';
import { trpc } from '~/utils/trpc';
import { CreateBuzzSessionInput } from '~/server/schema/stripe.schema';
import { getClientStripe } from '~/utils/get-client-stripe';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { openBuyBuzzModal } from '~/components/Modals/BuyBuzzModal';
import { useIsMobile } from '~/hooks/useIsMobile';
import React from 'react';
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
        await queryUtils.buzz.getUserAccount.invalidate();
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
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();
  const isMobile = useIsMobile();

  const { trackAction } = useTrackEvent();

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
      trackAction({ type: 'NotEnoughFunds', details: { amount: buzzAmount } }).catch(
        () => undefined
      );

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
