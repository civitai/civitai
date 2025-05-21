import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { hideNotification, showNotification } from '@mantine/notifications';

import { trpc } from '~/utils/trpc';

export const useNowPaymentsStatus = () => {
  const { data = {}, isLoading } = trpc.nowPayments.getStatus.useQuery();

  return {
    ...data,
    isLoading,
  };
};

const CREATE_TRANSACTION_TOAST_ID = 'CREATE_TRANSACTION_TOAST_ID';

export const useMutateNowPayments = () => {
  const queryUtils = trpc.useContext();

  const createTransactionMutation = trpc.nowPayments.createTransaction.useMutation({
    async onSuccess() {
      await queryUtils.nowPayments.getStatus.invalidate();
      showSuccessNotification({ message: 'Transaction created successfully' });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to create transaction',
        error: new Error(error.message),
      });
    },
  });

  const getPriceEstimateMutation = trpc.nowPayments.getPriceEstimate.useMutation({
    async onSuccess() {
      showSuccessNotification({ message: 'Price estimate retrieved successfully' });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to retrieve price estimate',
        error: new Error(error.message),
      });
    },
  });

  const handleCreateTransaction = (data: any) => {
    showNotification({
      id: CREATE_TRANSACTION_TOAST_ID,
      message: 'Creating transaction...',
      loading: true,
    });

    return createTransactionMutation.mutateAsync(data).finally(() => {
      hideNotification(CREATE_TRANSACTION_TOAST_ID);
    });
  };

  const handleGetPriceEstimate = (data: any) => {
    return getPriceEstimateMutation.mutateAsync(data);
  };

  const createPaymentInvoiceMutation = trpc.nowPayments.createPaymentInvoice.useMutation({
    async onSuccess() {
      showSuccessNotification({ message: 'Payment invoice created successfully' });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to create payment invoice',
        error: new Error(error.message),
      });
    },
  });

  const handleCreatePaymentInvoice = (data: any) => {
    return createPaymentInvoiceMutation.mutateAsync(data);
  };

  return {
    createTransaction: handleCreateTransaction,
    creatingTransaction: createTransactionMutation.isLoading,
    getPriceEstimate: handleGetPriceEstimate,
    gettingPriceEstimate: getPriceEstimateMutation.isLoading,
    createPaymentInvoice: handleCreatePaymentInvoice,
    creatingPaymentInvoice: createPaymentInvoiceMutation.isLoading,
  };
};
