import { CryptoTransactionStatus } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const useCoinbaseStatus = () => {
  const { data: healthy, isLoading } = trpc.coinbase.getStatus.useQuery();

  return {
    healthy: healthy ?? false,
    isLoading,
  };
};

export const useMutateCoinbase = () => {
  const createBuzzOrderMutation = trpc.coinbase.createBuzzOrder.useMutation({
    async onSuccess() {
      showSuccessNotification({ message: 'Redirecting to coinbase...' });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to create Coinbase order',
        error: new Error(error.message),
      });
    },
  });

  const createBuzzOrderOnrampMutation = trpc.coinbase.createBuzzOrderOnramp.useMutation({
    async onSuccess() {
      showSuccessNotification({ message: 'Redirecting to coinbase...' });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to create Coinbase onramp order',
        error: new Error(error.message),
      });
    },
  });

  const handleCreateBuzzOrder = (data: any) => {
    return createBuzzOrderMutation.mutateAsync(data);
  };
  const handleCreateBuzzOrderOnramp = (data: any) => {
    return createBuzzOrderOnrampMutation.mutateAsync(data);
  };

  return {
    createBuzzOrder: handleCreateBuzzOrder,
    creatingBuzzOrder: createBuzzOrderMutation.isLoading,
    createBuzzOrderOnramp: handleCreateBuzzOrderOnramp,
    creatingBuzzOrderOnramp: createBuzzOrderOnrampMutation.isLoading,
  };
};

export const useGetTransactionStatus = (key?: string | null) => {
  const { data: status, isLoading } = trpc.coinbase.getTransactionStatus.useQuery(
    {
      id: key ?? '',
    },
    {
      enabled: !!key,
      // Every 5s.
      // refetchInterval: 5000, // Refetch every 10 seconds
      // refetchOnWindowFocus: false,
    }
  );

  return {
    isLoading,
    status: status ?? null,
    isSuccess: !!status && status === CryptoTransactionStatus.Complete,
    isFailed:
      !!status &&
      [CryptoTransactionStatus.RampFailed, CryptoTransactionStatus.SweepFailed].some(
        (s) => s === status
      ),
  };
};
