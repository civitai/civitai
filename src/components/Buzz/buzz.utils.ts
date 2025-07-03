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
import { purchasableBuzzAccountTypes } from '~/server/schema/buzz.schema';
import type { BuzzAccountType, PurchasableBuzzType } from '~/server/schema/buzz.schema';

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
        `//${env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN as string}/purchase/buzz?${QS.stringify(query)}`,
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
  pct: Partial<Record<BuzzAccountType, number>>;
  amt: Partial<Record<BuzzAccountType, number>>;
};

export const useBuzzTransaction = (opts?: {
  message?: string | ((requiredBalance: number) => string);
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  performTransactionOnPurchase?: boolean;
  accountTypes?: BuzzAccountType[];
}) => {
  const {
    message,
    purchaseSuccessMessage,
    performTransactionOnPurchase,
    accountTypes = ['user'],
  } = opts ?? {};

  if (accountTypes.length === 0) {
    throw new Error(
      'useBuzzTransaction hook requires at least one account type. This is likely be a bug. Please contact support.'
    );
  }

  const features = useFeatureFlags();
  const queryUtils = trpc.useUtils();

  const { balances, balanceLoading } = useBuzz(undefined, accountTypes);
  const isMobile = useIsMobile();
  const onBuyBuzz = useBuyBuzz();
  const purchasableValue = accountTypes.find((t) =>
    purchasableBuzzAccountTypes.some((x) => x === t)
  ) as PurchasableBuzzType;

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
    // Ensure we use the relevant sort:
    return accountTypes
      .map((t) => {
        const record = balances.find((b) => b.accountType === t);
        return record?.balance ?? 0;
      })
      .reduce((acc, b) => {
        return acc + b;
      }, 0);
  };

  const hasRequiredAmount = (buzzAmount: number) => getCurrentBalance() >= buzzAmount;

  const getTypeDistribution = (buzzAmount: number): BuzzTypeDistribution => {
    const data: BuzzTypeDistribution = {
      // Will fill with relevant account types:
      amt: {},
      pct: {},
    };

    let current = buzzAmount;

    accountTypes.forEach((accountType: BuzzAccountType) => {
      data.amt[accountType] = 0;
      data.pct[accountType] = 0;

      const accountBalance = balances.find((b) => b.accountType === accountType)?.balance ?? 0;
      if (current <= 0 || accountBalance <= 0) return;

      const taken = Math.min(accountBalance, current);
      data.amt[accountType] = taken;
      data.pct[accountType] = taken / buzzAmount;
      current -= taken;
    });

    return data;
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

      if (!purchasableValue) {
        showErrorNotification({
          title: 'Not enough Buzz',
          error: new Error(`You need at least ${buzzAmount} Buzz to perform this action.`),
        });

        return;
      }

      onBuyBuzz({
        message: typeof message === 'function' ? message(buzzAmount - balance) : message,
        minBuzzAmount: buzzAmount - balance,
        onPurchaseSuccess: performTransactionOnPurchase ? onPerformTransaction : undefined,
        purchaseSuccessMessage,
        // At this point, because `canPurchase` is true, we can safely assume the first type is a purchasable type:
        initialBuzzType: purchasableValue,
      });

      return;
    }

    onPerformTransaction();
  };

  return {
    hasRequiredAmount,
    getTypeDistribution,
    conditionalPerformTransaction,
    tipUserMutation,
    isLoadingBalance: balanceLoading,
    canPurchase: !purchasableValue,
  };
};
