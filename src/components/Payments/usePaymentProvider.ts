import { env } from '~/env/client';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { PaymentProvider } from '~/shared/utils/prisma/enums';

export const usePaymentProvider = () => {
  const featureFlags = useFeatureFlags();

  // Force Stripe for green environments
  if (featureFlags.isGreen) {
    return PaymentProvider.Stripe;
  }

  if (
    env.NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER === PaymentProvider.Paddle &&
    !env.NEXT_PUBLIC_PADDLE_TOKEN
  ) {
    return PaymentProvider.Stripe; // Fallback to Stripe if Paddle is not setup.
  }

  return env.NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER;
};
