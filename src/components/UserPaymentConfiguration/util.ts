import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { GetTipaltiDashbordUrlSchema } from '~/server/schema/user-payment-configuration.schema';
import { trpc } from '~/utils/trpc';

export const useUserPaymentConfiguration = () => {
  const currentUser = useCurrentUser();
  const { data: userPaymentConfiguration, isLoading } = trpc.userPaymentConfiguration.get.useQuery(
    undefined,
    {
      enabled: !!currentUser,
    }
  );

  return {
    userPaymentConfiguration,
    isLoading,
  };
};

export const useTipaltiConfigurationUrl = (
  input: GetTipaltiDashbordUrlSchema,
  enabled: boolean
) => {
  const { data: tipaltiConfigurationUrl, ...rest } =
    trpc.userPaymentConfiguration.getTipaltiDashboardUrl.useQuery(input, {
      enabled,
    });

  return { tipaltiConfigurationUrl, ...rest };
};
