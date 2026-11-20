import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { MediaType } from '~/shared/utils/prisma/enums';

/** Deletes a post's image after a confirmation and drops it from the editor and the cached post. */
export function useDeletePostImage(imageId: number, mediaType?: MediaType) {
  const noun = mediaType === MediaType.audio ? 'song' : 'image';
  const queryUtils = trpc.useUtils();
  const [postId, setImages] = usePostEditStore((state) => [state.post?.id, state.setImages]);

  const removeFromEditor = (id: number) => {
    setImages((state) => state.filter((x) => x.type !== 'added' || x.data.id !== id));
    if (postId)
      queryUtils.post.getEdit.setData({ id: postId }, (old) => {
        if (!old) return old;

        return { ...old, images: old.images?.filter((x) => x.id !== id) };
      });
  };

  const deleteImageMutation = trpc.image.delete.useMutation({
    onSuccess: (_, { id }) => removeFromEditor(id),
    onError: (error) => showErrorNotification({ error: new Error(error.message) }),
  });

  const onDelete = () =>
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: `Delete ${noun}`,
        message: `Are you sure you want to delete this ${noun}?`,
        labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
        confirmProps: { color: 'red', loading: deleteImageMutation.isPending },
        onConfirm: async () => await deleteImageMutation.mutateAsync({ id: imageId }),
      },
    });

  return { onDelete, removeFromEditor, isDeleting: deleteImageMutation.isPending };
}
