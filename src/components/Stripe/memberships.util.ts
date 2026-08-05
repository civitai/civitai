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
import { BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE } from '~/shared/utils/buzz-membership';

export const useActiveSubscription = ({
  checkWhenInBadState,
  includeCanceled,
  buzzType,
  includeBuzzPurchase,
}: {
  checkWhenInBadState?: boolean;
  includeCanceled?: boolean;
  buzzType?: BuzzSpendType;
  /**
   * Fall back to a Buzz-purchased membership when the colour slot is empty. Set it when
   * you're asking "does this user have a membership"; leave it off when you're probing a
   * specific colour to decide whether to point them at the other site.
   */
  includeBuzzPurchase?: boolean;
} = {}) => {
  const currentUser = useCurrentUser();
  const isMember = currentUser?.tier !== undefined;
  const [mainBuzzType] = useAvailableBuzz();

  const {
    data: subscription,
    isLoading,
    isFetching,
  } = trpc.subscriptions.getUserSubscription.useQuery(
    {
      buzzType: buzzType || mainBuzzType,
      includeBadState: checkWhenInBadState,
      includeCanceled,
      includeBuzzPurchase,
    },
    {
      enabled: !!currentUser && !!(isMember || checkWhenInBadState || includeCanceled),
    }
  );

  // getUserSubscription reads ONE `CustomerSubscription.buzzType` slot, and a Buzz-purchased
  // membership lives in its own — so it can't answer "does this user have a membership".
  // getAllUserSubscriptions is buzzType-agnostic and is the source of truth here; fall back
  // to it rather than to a second single-slot read, which is what kept failing.
  const { data: allSubscriptions, isLoading: allLoading } =
    trpc.subscriptions.getAllUserSubscriptions.useQuery(undefined, {
      enabled: !!currentUser && !!includeBuzzPurchase && !subscription,
    });

  const buzzMembership = includeBuzzPurchase
    ? allSubscriptions?.find((s) => s.buzzType === BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE)
    : undefined;

  // Shapes differ only in that getAllUserSubscriptions leaves product.metadata unparsed;
  // every field the consumers read is present on both.
  const activeSubscription = subscription ?? (buzzMembership as typeof subscription) ?? null;

  const meta = activeSubscription?.product?.metadata as SubscriptionProductMetadata;

  // `!isMember` short-circuits loading to false, but a Buzz membership may not set the
  // session tier — so with the fallback on, report real loading instead of "done, nothing",
  // which is what flashed the empty state on /user/membership.
  const stillLoading = isLoading || isFetching || allLoading;

  return {
    subscription: activeSubscription,
    subscriptionLoading: !currentUser || (!isMember && !includeBuzzPurchase) ? false : stillLoading,
    subscriptionPaymentProvider: activeSubscription?.product?.provider,
    isFreeTier: (meta?.tier ?? currentUser?.tier ?? 'free') === 'free',
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

type PlanWithPrice = {
  price: { unitAmount: number | null };
  metadata: Record<string, unknown> | null;
};

/** Filter plans to tiers strictly above the user's current subscription tier. */
export function getEligibleUpgradePlans<T extends PlanWithPrice>(
  products: T[],
  subscription: { product: { metadata: Record<string, unknown> | null } } | null | undefined
): T[] {
  const subMeta = subscription?.product?.metadata as SubscriptionProductMetadata | undefined;
  return products.filter((p) => {
    const m = (p?.metadata ?? { tier: 'free' }) as SubscriptionProductMetadata;
    if (
      subscription &&
      subMeta &&
      constants.memberships.tierOrder.indexOf(subMeta.tier) >=
        constants.memberships.tierOrder.indexOf(m.tier)
    ) {
      return false;
    }
    return true;
  });
}

/** Pick the plan whose price is closest to `unitAmount` (cents). */
export function pickClosestPlanByPrice<T extends PlanWithPrice>(
  plans: T[],
  unitAmount: number
): T | undefined {
  if (!plans.length) return undefined;
  return plans.reduce((closest, plan) => {
    const a = plan.price.unitAmount ?? 0;
    const b = closest.price.unitAmount ?? 0;
    return Math.abs(a - unitAmount) < Math.abs(b - unitAmount) ? plan : closest;
  });
}

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
