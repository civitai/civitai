import { useEffect, useMemo, useState } from 'react';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { GetByIdStringInput } from '~/server/schema/base.schema';
import {
  GetPaddleAdjustmentsSchema,
  TransactionWithSubscriptionCreateInput,
  UpdateSubscriptionInputSchema,
} from '~/server/schema/paddle.schema';
import { trpc } from '~/utils/trpc';

export const useMutatePaddle = () => {
  const queryUtils = trpc.useUtils();
  const processCompleteBuzzTransactionMutation =
    trpc.paddle.processCompleteBuzzTransaction.useMutation();
  const updateSubscriptionMutation = trpc.paddle.updateSubscription.useMutation();
  const cancelSubscriptionMutation = trpc.paddle.cancelSubscription.useMutation();
  const purchaseBuzzWithSubscription = trpc.paddle.purchaseBuzzWithSubscription.useMutation();
  const getOrCreateCustomerIdMutation = trpc.paddle.getOrCreateCustomer.useMutation();
  const refreshSubscriptionMutation = trpc.paddle.refreshSubscription.useMutation({
    onSuccess: async () => {
      await queryUtils.subscriptions.getUserSubscription.invalidate();
    },
  });

  const handleProcessCompleteBuzzTransaction = (data: GetByIdStringInput) => {
    return processCompleteBuzzTransactionMutation.mutateAsync(data);
  };

  const handleUpdateSubscription = (
    data: UpdateSubscriptionInputSchema,
    opts: Parameters<typeof updateSubscriptionMutation.mutateAsync>[1]
  ) => {
    return updateSubscriptionMutation.mutateAsync(data, opts);
  };

  const handleCancelSubscriptionMutation = (
    opts: Parameters<typeof cancelSubscriptionMutation.mutateAsync>[1]
  ) => {
    return cancelSubscriptionMutation.mutateAsync(undefined, opts);
  };

  const handlePurchaseBuzzWithSubscription = (data: TransactionWithSubscriptionCreateInput) => {
    return purchaseBuzzWithSubscription.mutateAsync(data);
  };

  const handleGetOrCreateCustomer = () => {
    return getOrCreateCustomerIdMutation.mutateAsync();
  };

  const handleRefreshSubscription = () => {
    return refreshSubscriptionMutation.mutateAsync();
  };

  return {
    processCompleteBuzzTransaction: handleProcessCompleteBuzzTransaction,
    processingCompleteBuzzTransaction: processCompleteBuzzTransactionMutation.isLoading,
    updateSubscription: handleUpdateSubscription,
    updatingSubscription: updateSubscriptionMutation.isLoading,
    cancelSubscription: handleCancelSubscriptionMutation,
    cancelingSubscription: cancelSubscriptionMutation.isLoading,
    purchaseBuzzWithSubscription: handlePurchaseBuzzWithSubscription,
    purchasingBuzzWithSubscription: purchaseBuzzWithSubscription.isLoading,
    getOrCreateCustomer: handleGetOrCreateCustomer,
    gettingOrCreateCustomer: getOrCreateCustomerIdMutation.isLoading,
    refreshSubscription: handleRefreshSubscription,
    refreshingSubscription: refreshSubscriptionMutation.isLoading,
  };
};

export const useSubscriptionManagementUrls = (data: { enabled?: boolean } = { enabled: true }) => {
  const currentUser = useCurrentUser();
  const { data: managementUrls, ...rest } = trpc.paddle.getManagementUrls.useQuery(undefined, {
    enabled: !!currentUser && data?.enabled,
    trpc: { context: { skipBatch: true } },
  });

  return {
    managementUrls,
    ...rest,
  };
};

export const useHasPaddleSubscription = () => {
  const currentUser = useCurrentUser();

  const {
    data: hasPaddleSubscription,
    isLoading,
    isInitialLoading,
  } = trpc.paddle.hasSubscription.useQuery(undefined, {
    enabled: !!currentUser,
  });

  return {
    hasPaddleSubscription,
    isLoading,
    isInitialLoading,
  };
};

export const usePaddleAdjustmentsInfinite = (
  input?: GetPaddleAdjustmentsSchema,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const { data, isLoading, ...rest } = trpc.paddle.getAdjustmentsInfinite.useInfiniteQuery(
    { ...(input ?? {}) },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      trpc: { context: { skipBatch: true } },
      ...options,
    }
  );

  const flatData = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  return {
    adjustments: flatData,
    isLoading,
    ...rest,
  };
};

export const usePaddleSubscriptionRefresh = () => {
  const currentUser = useCurrentUser();
  const { refreshSubscription, refreshingSubscription } = useMutatePaddle();
  const { hasPaddleSubscription, isLoading: loadingPaddleSubscriptionStatus } =
    useHasPaddleSubscription();
  // Avoids getting stuck in a loop
  const [refreshed, setRefreshed] = useState(false);

  const { subscription, subscriptionLoading } = useActiveSubscription({
    checkWhenInBadState: true,
  });

  const isLoading =
    currentUser &&
    (refreshingSubscription || loadingPaddleSubscriptionStatus || subscriptionLoading);

  const handleRefresh = async () => {
    await refreshSubscription();
    setRefreshed(true);
  };

  useEffect(() => {
    if (isLoading || refreshed) {
      return;
    }

    if (!subscription && hasPaddleSubscription) {
      handleRefresh();
    }
  }, [hasPaddleSubscription, subscription, refreshSubscription, isLoading, refreshed]);

  return isLoading;
};
