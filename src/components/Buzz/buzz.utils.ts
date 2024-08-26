import { useRouter } from 'next/router';
import React, { useState } from 'react';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { openBuyBuzzModal } from '~/components/Modals/BuyBuzzModal';
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
  const queryUtils = trpc.useUtils();

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
  type?: 'user:generation' | 'Default';
}) => {
  const { message, purchaseSuccessMessage, performTransactionOnPurchase, type } = opts ?? {};

  const features = useFeatureFlags();
  const { balance: userBalance } = useBuzz();
  const { balance: generationBalance } = useBuzz(undefined, 'user:generation');
  const isMobile = useIsMobile();

  const { trackAction } = useTrackEvent();

  const tipUserMutation = trpc.buzz.tipUser.useMutation({
    onError(error) {
      showErrorNotification({
        title: 'Looks like there was an error sending your tip.',
        error: new Error(error.message),
      });
    },
  });

  const getCurrentBalance = () => {
    switch (type) {
      case 'user:generation':
        return userBalance + generationBalance;
      default:
        return userBalance;
    }
  };

  const hasRequiredAmount = (buzzAmount: number) => getCurrentBalance() >= buzzAmount;
  const hasTypeRequiredAmount = (buzzAmount: number) => {
    switch (type) {
      case 'user:generation':
        return generationBalance >= buzzAmount;
      default:
        return userBalance >= buzzAmount;
    }
  };

  const conditionalPerformTransaction = (buzzAmount: number, onPerformTransaction: () => void) => {
    if (!features.buzz) return onPerformTransaction();

    const balance = getCurrentBalance();
    const meetsRequirement = hasRequiredAmount(buzzAmount);
    if (!meetsRequirement) {
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
    hasTypeRequiredAmount,
    conditionalPerformTransaction,
    tipUserMutation,
  };
};
