import { useRef } from 'react';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import type { CreateCodeOrder } from '~/server/schema/coinbase.schema';

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

  const handleCreateBuzzOrder = (data: any) => {
    return createBuzzOrderMutation.mutateAsync(data);
  };

  return {
    createBuzzOrder: handleCreateBuzzOrder,
    creatingBuzzOrder: createBuzzOrderMutation.isLoading,
  };
};

export const useMutateCoinbaseCodeOrder = () => {
  const createCodeOrderMutation = trpc.coinbase.createCodeOrder.useMutation({
    async onSuccess() {
      showSuccessNotification({ message: 'Redirecting to Coinbase checkout...' });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to create code order',
        error: new Error(error.message),
      });
    },
  });

  const handleCreateCodeOrder = (data: CreateCodeOrder) => {
    return createCodeOrderMutation.mutateAsync(data);
  };

  return {
    createCodeOrder: handleCreateCodeOrder,
    creatingCodeOrder: createCodeOrderMutation.isLoading,
  };
};

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_DURATION_MS = 10 * 60 * 1000; // 10 minutes

export const useCodeOrderStatus = (orderId: string | undefined) => {
  const startTimeRef = useRef(Date.now());

  const { data, isLoading, isError } = trpc.coinbase.getCodeOrder.useQuery(
    { orderId: orderId! },
    {
      enabled: !!orderId,
      refetchInterval: (data) => {
        if (data?.status === 'completed') return false;
        // Stop polling after max duration
        if (Date.now() - startTimeRef.current > MAX_POLL_DURATION_MS) return false;
        return POLL_INTERVAL_MS;
      },
      retry: 3,
    }
  );

  const timedOut =
    !data || data.status !== 'completed'
      ? Date.now() - startTimeRef.current > MAX_POLL_DURATION_MS
      : false;

  return {
    order: data,
    isLoading,
    isError,
    timedOut,
  };
};
