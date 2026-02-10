import TosViolationDialog from '~/components/Dialog/Common/TosViolationDialog';
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
      component: TosViolationDialog,
      props: {
        title: 'Remove as TOS Violation',
        message: 'The uploader will be notified that their image was removed.',
        onConfirm: async (violationType: string, violationDetails?: string) => {
          await mutateAsync({ id: imageId, violationType, violationDetails });
          imageStore.setImage(imageId, { tosViolation: true });
        },
      },
    });
  };
}
