import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { ConfirmDialog } from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';

export function useDeleteImage() {
  const deleteImageMutation = trpc.image.delete.useMutation({
    onError: (error: any) => showErrorNotification({ error: new Error(error.message) }),
  });

  return function ({ imageId }: { imageId: number }) {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Delete image',
        message: 'Are you sure you want to delete this image?',
        labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
        confirmProps: { color: 'red', loading: deleteImageMutation.isLoading },
        onConfirm: async () => await deleteImageMutation.mutateAsync({ id: imageId }),
      },
    });
  };
}
