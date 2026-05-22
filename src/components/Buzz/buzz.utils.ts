import { useRouter } from 'next/router';
import type React from 'react';
import { useState } from 'react';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { BuyBuzzModalProps } from '~/components/Modals/BuyBuzzModal';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useServerDomains } from '~/providers/AppProvider';
import type { CreateBuzzSessionInput } from '~/server/schema/stripe.schema';
import { getClientStripe } from '~/utils/get-client-stripe';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { QS } from '~/utils/qs';
import { syncAccount } from '~/utils/sync-account';
import { trpc } from '~/utils/trpc';
import { useTrackEvent } from '../TrackView/track.utils';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import dynamic from 'next/dynamic';

const BuyBuzzModal = dynamic(() => import('~/components/Modals/BuyBuzzModal'));

export const useBuyBuzz = (): ((props: BuyBuzzModalProps) => void) => {
  const features = useFeatureFlags();
  const serverDomains = useServerDomains();

  return async function (props: BuyBuzzModalProps) {
    if (!features.canBuyBuzz) {
      const query = { minBuzzAmount: props.minBuzzAmount };

      window.open(
        syncAccount(`//${serverDomains.green}/purchase/buzz?${QS.stringify(query)}`),
        '_blank',
        'noreferrer'
      );
    } else {
      dialogStore.trigger({
        id: 'buy-buzz-modal',
        component: BuyBuzzModal,
        props,
      });
    }
  };
};

export const useBuzzTransaction = (opts?: {
  message?: string | ((requiredBalance: number) => string);
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  performTransactionOnPurchase?: boolean;
  accountTypes?: BuzzSpendType[];
}) => {
  const defaultAccountTypes = useAvailableBuzz();
  const {
    message,
    purchaseSuccessMessage,
    performTransactionOnPurchase,
    accountTypes = defaultAccountTypes,
  } = opts ?? {};

  const features = useFeatureFlags();
  const queryUtils = trpc.useUtils();

  const {
    data: { accounts, total },
    isLoading,
  } = useQueryBuzz(accountTypes);

  const onBuyBuzz = useBuyBuzz();
  const initialBuzzType = accounts[0]?.type;
  const purchasableValue = accounts.find((x) => x.purchasable)?.type;

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

  const hasRequiredAmount = (buzzAmount: number) => total >= buzzAmount;

  /**
   * Runs `onPerformTransaction` if the user can afford `buzzAmount`, otherwise
   * routes into the not-enough-funds / buy-buzz flow.
   *
   * Returns `true` only when `onPerformTransaction` was actually invoked
   * synchronously (the transaction proceeded). Returns `false` for every
   * early-return branch where the transaction did NOT proceed:
   *   - balance still loading (`isLoading`)
   *   - insufficient funds, no purchasable account (error toast shown)
   *   - insufficient funds, buy-buzz modal opened
   *
   * Callers that hold gesture/UI state (e.g. InteractiveTipBuzzButton's
   * `gestureCommittedRef`) must inspect this return value: a `false` result
   * means the gesture terminated here without going through the transaction's
   * own cleanup (`onSettled`), so the caller is responsible for resetting its
   * own state.
   */
  const conditionalPerformTransaction = (
    buzzAmount: number,
    onPerformTransaction: () => void
  ): boolean => {
    if (!features.buzz) {
      onPerformTransaction();
      return true;
    }

    if (isLoading) return false;

    const balance = total;
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

        return false;
      }

      onBuyBuzz({
        message: typeof message === 'function' ? message(buzzAmount - balance) : message,
        minBuzzAmount: buzzAmount - balance,
        onPurchaseSuccess: performTransactionOnPurchase ? onPerformTransaction : undefined,
        purchaseSuccessMessage,
        // At this point, because `canPurchase` is true, we can safely assume the first type is a purchasable type:
        initialBuzzType,
      });

      return false;
    }

    // Affordable — run the transaction. Its own lifecycle (e.g. mutation
    // onSettled) is responsible for any post-transaction cleanup.
    onPerformTransaction();
    return true;
  };

  return {
    hasRequiredAmount,
    conditionalPerformTransaction,
    tipUserMutation,
    isLoadingBalance: isLoading,
    canPurchase: !purchasableValue,
  };
};
