import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

export const useUserPaymentConfiguration = () => {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const { data: userPaymentConfiguration, isLoading } = trpc.userPaymentConfiguration.get.useQuery(
    undefined,
    {
      enabled: !!features.creatorsProgram && !!currentUser,
    }
  );

  return {
    userPaymentConfiguration,
    isLoading,
  };
};

export const useTipaltiConfigurationUrl = (enabled: boolean) => {
  const { data: tipaltiConfigurationUrl, ...rest } =
    trpc.userPaymentConfiguration.getTipaltiOnboardingUrl.useQuery(undefined, {
      enabled,
    });

  return { tipaltiConfigurationUrl, ...rest };
};
