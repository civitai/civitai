import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

export function useRescanImage() {
  const { mutateAsync } = trpc.image.rescan.useMutation({
    onSuccess() {
      showSuccessNotification({ message: 'Image sent for rescan' });
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not rescan image, please try again',
      });
    },
  });

  return async function ({ imageId }: { imageId: number }) {
    mutateAsync({ id: imageId });
  };
}
