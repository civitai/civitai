import { useEffect, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { GetPaginatedUserTransactionHistorySchema } from '~/server/schema/coinbase.schema';
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
  const utils = trpc.useUtils();
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
    onError(error) {
      showErrorNotification({
        title: 'Failed to create Coinbase onramp order',
        error: new Error(error.message),
      });
    },
  });

  const processUserPendingTransactionsMutation =
    trpc.coinbase.processUserPendingTransactions.useMutation({
      async onSuccess() {
        showSuccessNotification({ message: 'Transactions processed!' });
        utils.coinbase.getPaginatedUserTransactions.invalidate();
        utils.coinbase.getUserWalletBalance.invalidate();
      },
      onError(error) {
        showErrorNotification({
          title: 'Failed to process transactions',
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
  const handleProcessUserPendingTransactions = () => {
    return processUserPendingTransactionsMutation.mutateAsync();
  };

  return {
    createBuzzOrder: handleCreateBuzzOrder,
    creatingBuzzOrder: createBuzzOrderMutation.isLoading,
    createBuzzOrderOnramp: handleCreateBuzzOrderOnramp,
    creatingBuzzOrderOnramp: createBuzzOrderOnrampMutation.isLoading,
    processUserPendingTransactions: handleProcessUserPendingTransactions,
    processingUserPendingTransactions: processUserPendingTransactionsMutation.isLoading,
  };
};

export const useGetTransactionStatus = (key?: string | null) => {
  const [stopRefetch, setStopRefetch] = useState<boolean>(false);
  const { data: status, isLoading } = trpc.coinbase.getTransactionStatus.useQuery(
    {
      id: key ?? '',
    },
    {
      enabled: !!key,
      // Every 5s.
      ...(stopRefetch
        ? {
            refetchInterval: false, // Stop refetching if status is set
          }
        : {
            refetchInterval: 5000, // Refetch every 10 seconds
            refetchOnWindowFocus: false,
          }),
    }
  );

  useEffect(() => {
    setStopRefetch(
      !!status &&
        [
          CryptoTransactionStatus.Complete,
          CryptoTransactionStatus.RampFailed,
          CryptoTransactionStatus.SweepFailed,
        ].some((s) => s === status)
    );
  }, [status]);

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

export const useQueryPaginatedUserTransactionHistory = (
  filters?: Partial<GetPaginatedUserTransactionHistorySchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const { data, ...rest } = trpc.coinbase.getPaginatedUserTransactions.useQuery(
    {
      ...filters,
    },
    {
      ...options,
      enabled: options?.enabled ?? true,
    }
  );

  if (data) {
    const { items: items = [], ...pagination } = data;
    return { items, pagination, ...rest };
  }

  return { items: [], pagination: null, ...rest };
};

export const useCoinbaseOnrampBalance = () => {
  const { data, isLoading } = trpc.coinbase.getUserWalletBalance.useQuery();

  return {
    data: data ?? null,
    isLoading,
  };
};
