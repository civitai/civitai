import { useEffect, useState } from 'react';
import { CryptoTransactionStatus } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const useMutateZkp2p = () => {
  const createBuzzOrderOnrampMutation = trpc.zkp2p.createBuzzOrderOnramp.useMutation({
    onError(error) {
      showErrorNotification({
        title: 'Failed to create ZKP2P onramp order',
        error: new Error(error.message),
      });
    },
  });

  const handleCreateBuzzOrderOnramp = (data: { unitAmount: number; buzzAmount: number }) => {
    return createBuzzOrderOnrampMutation.mutateAsync(data);
  };

  return {
    createBuzzOrderOnramp: handleCreateBuzzOrderOnramp,
    creatingBuzzOrderOnramp: createBuzzOrderOnrampMutation.isLoading,
  };
};

export const useGetZkp2pTransactionStatus = (key?: string | null) => {
  const [stopRefetch, setStopRefetch] = useState<boolean>(false);
  const { data: status, isLoading } = trpc.zkp2p.getTransactionStatusByKey.useQuery(
    {
      key: key ?? '',
    },
    {
      enabled: !!key,
      // Every 5s.
      ...(stopRefetch
        ? {
            refetchInterval: false, // Stop refetching if status is set
          }
        : {
            refetchInterval: 5000, // Refetch every 5 seconds
            refetchOnWindowFocus: false,
          }),
    }
  );

  useEffect(() => {
    setStopRefetch(
      !!status &&
        [
          CryptoTransactionStatus.Complete,
          CryptoTransactionStatus.RampTimedOut,
          CryptoTransactionStatus.RampFailed,
          CryptoTransactionStatus.SweepFailed,
        ].some((s) => s === status.status)
    );
  }, [status]);

  useEffect(() => {
    if (status?.status === CryptoTransactionStatus.Complete) {
      showSuccessNotification({
        title: 'Payment Complete!',
        message: 'Your Buzz has been added to your account.',
      });
    }
  }, [status]);

  return {
    status,
    isLoading,
  };
};
