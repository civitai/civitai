import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { ProductMetadata } from '~/server/schema/stripe.schema';
import { trpc } from '~/utils/trpc';

export const useActiveSubscription = () => {
  const currentUser = useCurrentUser();
  const isMember = currentUser?.tier !== undefined;

  const { data: subscription, isLoading } = trpc.stripe.getUserSubscription.useQuery(undefined, {
    enabled: !!currentUser && isMember,
  });

  return { subscription, subscriptionLoading: !isMember ? false : isLoading };
};

export const useCanUpgrade = () => {
  const currentUser = useCurrentUser();
  const { subscription, subscriptionLoading } = useActiveSubscription();
  const { data: products = [], isLoading: productsLoading } = trpc.stripe.getPlans.useQuery();

  if (!currentUser || subscriptionLoading || productsLoading) {
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

export const appliesForFounderDiscount = (tier?: UserTier) => {
  const appliesForDiscount =
    !!tier && tier === 'silver' && new Date() < constants.memberships.maxDiscountDate;

  return appliesForDiscount;
};
