import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { hideNotification, showNotification } from '@mantine/notifications';

import { trpc } from '~/utils/trpc';

export const useNowPaymentsStatus = () => {
  const { data = { healthy: false }, isLoading } = trpc.nowPayments.getStatus.useQuery();

  return {
    ...data,
    isLoading,
  };
};

const CREATE_TRANSACTION_TOAST_ID = 'CREATE_TRANSACTION_TOAST_ID';

export const useMutateNowPayments = () => {
  const queryUtils = trpc.useContext();

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
    getPriceEstimate: handleGetPriceEstimate,
    gettingPriceEstimate: getPriceEstimateMutation.isLoading,
    createPaymentInvoice: handleCreatePaymentInvoice,
    creatingPaymentInvoice: createPaymentInvoiceMutation.isLoading,
  };
};
