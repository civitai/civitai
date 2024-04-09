import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { ProductMetadata } from '~/server/schema/stripe.schema';
import { trpc } from '~/utils/trpc';

export const useActiveSubscription = ({
  checkWhenInBadState,
}: {
  checkWhenInBadState?: boolean;
} = {}) => {
  const currentUser = useCurrentUser();
  const isMember = currentUser?.tier !== undefined;

  const {
    data: subscription,
    isLoading,
    isFetching,
  } = trpc.stripe.getUserSubscription.useQuery(undefined, {
    enabled:
      !!currentUser && !!(isMember || (checkWhenInBadState && currentUser?.memberInBadState)),
  });

  return { subscription, subscriptionLoading: !isMember ? false : isLoading || isFetching };
};

export const useCanUpgrade = () => {
  const currentUser = useCurrentUser();
  const { subscription, subscriptionLoading } = useActiveSubscription();
  const { data: products = [], isLoading: productsLoading } = trpc.stripe.getPlans.useQuery();
  const features = useFeatureFlags();

  if (!currentUser || subscriptionLoading || productsLoading || !features.membershipsV2) {
    return false;
  }

  if (!subscription) {
    return true;
  }

  if (products.length <= 1) {
    return false;
  }

  const metadata = subscription?.product?.metadata as ProductMetadata;

  return (
    constants.memberships.tierOrder.indexOf(metadata.tier) + 1 <
    constants.memberships.tierOrder.length
  );
};

export const appliesForFounderDiscount = (tier?: string) => {
  const appliesForDiscount =
    !!tier &&
    tier === constants.memberships.founderDiscount.tier &&
    new Date() < constants.memberships.founderDiscount.maxDiscountDate;

  return appliesForDiscount;
};
