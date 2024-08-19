import { env } from '~/env/client.mjs';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { PaymentProvider } from '@prisma/client';

export const usePaymentProvider = () => {
  const featureFlags = useFeatureFlags();

  if (!featureFlags.customPaymentProvider) {
    return PaymentProvider.Stripe; //
  }

  return env.NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER;
};
