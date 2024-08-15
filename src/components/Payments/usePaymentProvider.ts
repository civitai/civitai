import { env } from '~/env/client.mjs';

export const usePaymentProvider = () => {
  return env.NEXT_PUBLIC_PAYMENT_PROVIDER;
};
