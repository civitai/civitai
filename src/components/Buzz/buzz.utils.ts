import { useRouter } from 'next/router';
import type React from 'react';
import { useState } from 'react';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { BuyBuzzModalProps } from '~/components/Modals/BuyBuzzModal';
import { env } from '~/env/client';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { CreateBuzzSessionInput } from '~/server/schema/stripe.schema';
import { getClientStripe } from '~/utils/get-client-stripe';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { QS } from '~/utils/qs';
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

export const useBuyBuzz = (): ((props: BuyBuzzModalProps) => void) => {
  const features = useFeatureFlags();

  return async function (props: BuyBuzzModalProps) {
    if (!features.canBuyBuzz) {
      const query = {
        minBuzzAmount: props.minBuzzAmount,
        'sync-account': 'blue',
      };

      window.open(
        `//${env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN}/purchase/buzz?${QS.stringify(query)}`,
        '_blank',
        'noreferrer'
      );
    } else {
      const BuyBuzzModal = (await import('~/components/Modals/BuyBuzzModal')).default;
      dialogStore.trigger({
        id: 'buy-buzz-modal',
        component: BuyBuzzModal,
        props,
      });
    }
  };
};

export type BuzzTypeDistribution = {
  pct: { blue: number; yellow: number };
  amt: { blue: number; yellow: number };
};

export const useBuzzTransaction = (opts?: {
  message?: string | ((requiredBalance: number) => string);
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  performTransactionOnPurchase?: boolean;
  type?: 'Generation' | 'Default';
}) => {
  const { message, purchaseSuccessMessage, performTransactionOnPurchase, type } = opts ?? {};

  const features = useFeatureFlags();
  const queryUtils = trpc.useUtils();

  const { balances, balanceLoading } = useBuzz(undefined, ['user', 'generation']);
  const generationBalance = balances.find((b) => b.accountType === 'generation')?.balance ?? 0;
  const userBalance = balances.find((b) => b.accountType === 'user')?.balance ?? 0;

  const isMobile = useIsMobile();
  const onBuyBuzz = useBuyBuzz();

  const { trackAction } = useTrackEvent();

  const tipUserMutation = trpc.buzz.tipUser.useMutation({
    async onSuccess() {
      await queryUtils.buzz.getBuzzAccount.invalidate();
    },
    onError(error) {
      showErrorNotification({
        title: 'Looks like there was an error sending your tip.',
        error: new Error(error.message),
      });
    },
  });

  const getCurrentBalance = () => {
    switch (type) {
      case 'Generation':
        return userBalance + generationBalance;
      default:
        return userBalance;
    }
  };

  const hasRequiredAmount = (buzzAmount: number) => getCurrentBalance() >= buzzAmount;
  const hasTypeRequiredAmount = (buzzAmount: number) => {
    switch (type) {
      case 'Generation':
        return generationBalance >= buzzAmount;
      default:
        return userBalance >= buzzAmount;
    }
  };
  const getTypeDistribution = (buzzAmount: number): BuzzTypeDistribution => {
    switch (type) {
      case 'Generation':
        if (generationBalance >= buzzAmount)
          return { amt: { blue: buzzAmount, yellow: 0 }, pct: { blue: 1, yellow: 0 } };

        const blueAmt = Math.max(0, generationBalance);
        const yellowAmt = buzzAmount - blueAmt;

        return {
          amt: {
            blue: blueAmt,
            yellow: yellowAmt,
          },
          pct: {
            blue: blueAmt / buzzAmount,
            yellow: yellowAmt / buzzAmount,
          },
        };
      default:
        return { amt: { blue: 0, yellow: buzzAmount }, pct: { blue: 0, yellow: 1 } };
    }
  };

  const conditionalPerformTransaction = (buzzAmount: number, onPerformTransaction: () => void) => {
    if (!features.buzz) return onPerformTransaction();

    if (balanceLoading) return;

    const balance = getCurrentBalance();
    const meetsRequirement = hasRequiredAmount(buzzAmount);
    if (!meetsRequirement) {
      trackAction({ type: 'NotEnoughFunds', details: { amount: buzzAmount } }).catch(
        () => undefined
      );

      onBuyBuzz({
        message: typeof message === 'function' ? message(buzzAmount - balance) : message,
        minBuzzAmount: buzzAmount - balance,
        onPurchaseSuccess: performTransactionOnPurchase ? onPerformTransaction : undefined,
        purchaseSuccessMessage,
      });

      return;
    }

    onPerformTransaction();
  };

  return {
    hasRequiredAmount,
    hasTypeRequiredAmount,
    getTypeDistribution,
    conditionalPerformTransaction,
    tipUserMutation,
    isLoadingBalance: balanceLoading,
  };
};
