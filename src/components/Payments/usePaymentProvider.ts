import { env } from '~/env/client.mjs';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { PaymentProvider } from '~/shared/utils/prisma/enums';

export const usePaymentProvider = () => {
  const featureFlags = useFeatureFlags();

  if (!featureFlags.customPaymentProvider) {
    return PaymentProvider.Stripe; //
  }

  if (
    env.NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER === PaymentProvider.Paddle &&
    !env.NEXT_PUBLIC_PADDLE_TOKEN
  ) {
    return PaymentProvider.Stripe; // Fallback to Stripe if Paddle is not setup.
  }

  return env.NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER;
};
