import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { DELETE_AFTER_REVIEW_MESSAGE } from '~/shared/constants/delete-after-review.constants';

const deleteAfterReviewOf = (result: unknown) =>
  (result as { deleteAfterReview?: unknown } | null | undefined)?.deleteAfterReview;

export const isDeleteAfterReview = (result: unknown) => !!deleteAfterReviewOf(result);

/** Shows the server's text; a server from before it chose the text sent `true`. */
export function notifyDeleteAfterReview(result: unknown) {
  const text = deleteAfterReviewOf(result);
  showSuccessNotification({
    message: typeof text === 'string' ? text : DELETE_AFTER_REVIEW_MESSAGE,
    autoClose: 8000,
  });
}

export function useDeleteImage() {
  const deleteImageMutation = trpc.image.delete.useMutation({
    onSuccess: (result) => {
      if (isDeleteAfterReview(result)) notifyDeleteAfterReview(result);
    },
    onError: (error: any) => showErrorNotification({ error: new Error(error.message) }),
  });

  return function ({ imageId }: { imageId: number }) {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Delete image',
        message: 'Are you sure you want to delete this image?',
        labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
        confirmProps: { color: 'red', loading: deleteImageMutation.isPending },
        onConfirm: async () => await deleteImageMutation.mutateAsync({ id: imageId }),
      },
    });
  };
}
