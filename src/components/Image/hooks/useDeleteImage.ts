import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { openConfirm } from '~/components/Dialog/Common/ConfirmDialog';
import { DELETE_AFTER_REVIEW_MESSAGE } from '~/shared/constants/delete-after-review.constants';

/**
 * Shows what the server says about a delete, and whether it said anything: the one text every member
 * delete gets (`deleteNotice`), or the review notice, which only a moderator's kept delete, or a
 * server from before `deleteNotice`, still sends.
 */
export function notifyDeleteNotice(result: unknown) {
  const { deleteAfterReview, deleteNotice } = (result ?? {}) as {
    deleteAfterReview?: unknown;
    deleteNotice?: unknown;
  };
  const message = deleteAfterReview
    ? DELETE_AFTER_REVIEW_MESSAGE
    : typeof deleteNotice === 'string'
    ? deleteNotice
    : undefined;
  if (message) showSuccessNotification({ message, autoClose: 8000 });
  return !!message;
}

export function useDeleteImage() {
  const deleteImageMutation = trpc.image.delete.useMutation({
    onSuccess: (result) => {
      notifyDeleteNotice(result);
    },
    onError: (error: any) => showErrorNotification({ error: new Error(error.message) }),
  });

  return function ({ imageId }: { imageId: number }) {
    openConfirm({
      title: 'Delete image',
      message: 'Are you sure you want to delete this image?',
      labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
      confirmProps: { color: 'red', loading: deleteImageMutation.isPending },
      onConfirm: async () => await deleteImageMutation.mutateAsync({ id: imageId }),
    });
  };
}
