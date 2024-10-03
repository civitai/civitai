import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

export const useUserPaymentConfiguration = () => {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const { data: userStripeConnect, isLoading } = trpc.userPaymentConfiguration.get.useQuery(
    undefined,
    {
      enabled: !!features.creatorsProgram && !!currentUser,
    }
  );

  return {
    userStripeConnect,
    isLoading,
  };
};
