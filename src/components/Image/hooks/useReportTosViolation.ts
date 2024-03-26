import { ConfirmDialog } from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { trpc } from '~/utils/trpc';
import { imageStore } from '~/store/image.store';
import { showErrorNotification } from '~/utils/notifications';

export function useReportTosViolation() {
  const { mutateAsync } = trpc.image.setTosViolation.useMutation({
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not report review, please try again',
      });
    },
  });

  return function ({ imageId }: { imageId: number }) {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Report ToS Violation',
        message:
          'Are you sure you want to remove this image as a Terms of Service violation? The uploader will be notified.',
        labels: { cancel: `Cancel`, confirm: `Yes` },
        confirmProps: { color: 'red' },
        onConfirm: async () => {
          await mutateAsync({ id: imageId });
          imageStore.setImage(imageId, { tosViolation: true });
        },
      },
    });
  };
}
