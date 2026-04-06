import type { CreateCodeOrder } from '~/server/schema/coinbase.schema';
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

export const useMutateCoinbaseCodeOrder = () => {
  const createCodeOrderMutation = trpc.coinbase.createCodeOrder.useMutation({
    async onSuccess() {
      showSuccessNotification({ message: 'Redirecting to Coinbase...' });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to create crypto order',
        error: new Error(error.message),
      });
    },
  });

  const handleCreateCodeOrder = async (data: CreateCodeOrder) => {
    const result = await createCodeOrderMutation.mutateAsync(data);
    if (result?.hosted_url) {
      window.location.replace(result.hosted_url);
    }
    return result;
  };

  return {
    createCodeOrder: handleCreateCodeOrder,
    creatingCodeOrder: createCodeOrderMutation.isLoading,
  };
};
