import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { showNotification, hideNotification } from '@mantine/notifications';
import { trpc } from '~/utils/trpc';
import { closeModal, openConfirmModal } from '@mantine/modals';

const SEND_REPORT_ID = 'sending-report';

export function useCreateReport(options?: Parameters<typeof trpc.report.create.useMutation>[0]) {
  const { onMutate, onSuccess, onError, onSettled, ...rest } = options ?? {};
  return trpc.report.create.useMutation({
    async onMutate(...args) {
      showNotification({
        id: SEND_REPORT_ID,
        loading: true,
        disallowClose: true,
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

// export function useReportCsam(options?: Parameters<typeof trpc.report.create.useMutation>[0]) {
//   const { onSuccess, ...rest } = options ?? {};

//   const createReport = useCreateReport({
//     async onSuccess(...args) {
//       closeModal('confirm-csam');
//       onSuccess?.(...args);
//     },
//     ...rest,
//   });

//   const mutate = (args: Parameters<typeof createReport.mutate>[0][]) => {
//     openConfirmModal({
//       modalId: 'confirm-csam',
//       title: 'Report CSAM',
//       children: `Are you sure you want to report this as CSAM?`,
//       centered: true,
//       labels: { confirm: 'Yes', cancel: 'Cancel' },
//       confirmProps: { color: 'red', loading: createReport.isLoading },
//       closeOnConfirm: false,
//       onConfirm: () => {
//         for (const item of args) {
//           createReport.mutate(item);
//         }
//       },
//     });
//   };

//   return { ...createReport, mutate };
// }
