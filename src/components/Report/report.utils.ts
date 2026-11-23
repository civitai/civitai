import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { showNotification, hideNotification } from '@mantine/notifications';
import { trpc } from '~/utils/trpc';

const SEND_REPORT_ID = 'sending-report';

export function useCreateReport(options?: Parameters<typeof trpc.report.create.useMutation>[0]) {
  const { onMutate, onSuccess, onError, onSettled, ...rest } = options ?? {};
  return trpc.report.create.useMutation({
    async onMutate(...args) {
      showNotification({
        id: SEND_REPORT_ID,
        loading: true,
        withCloseButton: false,
        autoClose: false,
        message: 'Sending report...',
      });
      await onMutate?.(...args);
    },
    async onSuccess(...args) {
      showSuccessNotification({
        title: 'Resource reported',
        message: 'Your request has been received',
      });
      await onSuccess?.(...args);
    },
    async onError(error, ...args) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Unable to send report',
        reason: error.message ?? 'An unexpected error occurred, please try again',
      });
      await onError?.(error, ...args);
    },
    async onSettled(...args) {
      hideNotification(SEND_REPORT_ID);
      await onSettled?.(...args);
    },
    ...rest,
  });
}
