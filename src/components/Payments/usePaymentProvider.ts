import { env } from '~/env/client.mjs';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export const usePaymentProvider = () => {
  const featureFlags = useFeatureFlags();

  if (!featureFlags.customPaymentProvider) {
    return 'stripe'; //
  }

  return env.NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER;
};
