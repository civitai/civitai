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

  return { subscription, subscriptionLoading: isLoading };
};

export const useCanUpgrade = () => {
  const currentUser = useCurrentUser();
  const { subscription, subscriptionLoading } = useActiveSubscription();

  if (!currentUser || subscriptionLoading) {
    return false;
  }

  const metadata = subscription?.product?.metadata as ProductMetadata;

  return (
    constants.memberships.tierOrder.indexOf(metadata.tier) + 1 <
    constants.memberships.tierOrder.length
  );
};
