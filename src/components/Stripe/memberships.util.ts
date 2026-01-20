import { useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import refreshSessions from '~/pages/api/admin/refresh-sessions';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { trpc } from '~/utils/trpc';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';

export const useActiveSubscription = ({
  checkWhenInBadState,
  buzzType,
}: {
  checkWhenInBadState?: boolean;
  buzzType?: BuzzSpendType;
} = {}) => {
  const currentUser = useCurrentUser();
  const isMember = currentUser?.tier !== undefined;
  const [mainBuzzType] = useAvailableBuzz();

  const {
    data: subscription,
    isLoading,
    isFetching,
  } = trpc.subscriptions.getUserSubscription.useQuery(
    { buzzType: buzzType || mainBuzzType, includeBadState: checkWhenInBadState },
    {
      enabled: !!currentUser && !!(isMember || checkWhenInBadState),
    }
  );

  const meta = subscription?.product?.metadata as SubscriptionProductMetadata;

  return {
    subscription,
    subscriptionLoading: !isMember || !currentUser ? false : isLoading || isFetching,
    subscriptionPaymentProvider: subscription?.product?.provider,
    isFreeTier: !subscription || meta?.tier === 'free',
    tier: meta?.tier ?? currentUser?.tier ?? 'free',
    meta,
  };
};

export const useCanUpgrade = () => {
  const currentUser = useCurrentUser();
  const { subscription, subscriptionLoading, subscriptionPaymentProvider } =
    useActiveSubscription();
  const paymentProvider = usePaymentProvider();
  const { data: products = [], isLoading: productsLoading } = trpc.subscriptions.getPlans.useQuery({
    paymentProvider,
  });
  const features = useFeatureFlags();

  if (!features.prepaidMemberships && features.disablePayments) {
    return false;
  }

  if (!currentUser || subscriptionLoading || productsLoading || !features.membershipsV2) {
    return false;
  }

  if (!subscription) {
    return true;
  }

  const availableProducts = products.filter((p) => p.provider === subscriptionPaymentProvider);

  if (availableProducts.length <= 1) {
    return false;
  }

  const metadata = subscription?.product?.metadata as SubscriptionProductMetadata;

  return (
    constants.memberships.tierOrder.indexOf(metadata.tier) + 1 <
    constants.memberships.tierOrder.length
  );
};

export const useRefreshSession = (shouldReload = true) => {
  const currentUser = useCurrentUser();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefreshSession = async () => {
    setRefreshing(true);
    await currentUser?.refresh();
    if (shouldReload) {
      window?.location.reload();
    }
    setRefreshing(false);
  };

  return {
    refreshSession: handleRefreshSession,
    refreshing,
  };
};
