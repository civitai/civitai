import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function useMutateEmerchantPay() {
  const { mutateAsync: createBuzzOrder, isLoading: creatingBuzzOrder } =
    trpc.emerchantpay.createBuzzOrder.useMutation({
      onError(error) {
        showErrorNotification({
          title: 'Unable to create payment',
          error: new Error(error.message),
        });
      },
    });

  return {
    createBuzzOrder,
    creatingBuzzOrder,
  };
}

export function useEmerchantPayStatus() {
  const { data: healthy, isLoading } = trpc.emerchantpay.getStatus.useQuery(undefined, {
    trpc: { context: { skipBatch: true } },
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    cacheTime: 1000 * 60 * 10, // 10 minutes
  });

  return { healthy, isLoading };
}

export function useGetTransactionStatus(uniqueId?: string | null) {
  const { data, isLoading } = trpc.emerchantpay.getTransactionStatus.useQuery(
    { id: uniqueId! },
    {
      enabled: !!uniqueId,
      refetchInterval: (data) => {
        if (!data) return 5000; // Refetch every 5 seconds if no data
        if (data.status === 'approved') return false; // Stop refetching if approved
        if (data.status === 'declined' || data.status === 'error') return false; // Stop refetching if failed
        return 5000; // Continue refetching for pending states
      },
    }
  );

  return {
    data,
    isLoading,
    isSuccess: data?.status === 'approved',
    isFailed: data?.status === 'declined' || data?.status === 'error',
  };
}
