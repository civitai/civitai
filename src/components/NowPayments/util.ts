import { trpc } from '~/utils/trpc';

export const useNowPaymentsStatus = () => {
  const { data = {}, isLoading } = trpc.nowPayments.getStatus.useQuery();

  return {
    ...data,
    isLoading,
  };
};
