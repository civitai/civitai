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

  const handleCreateBuzzOrder = (data: any) => {
    return createBuzzOrderMutation.mutateAsync(data);
  };

  return {
    createBuzzOrder: handleCreateBuzzOrder,
    creatingBuzzOrder: createBuzzOrderMutation.isLoading,
  };
};
