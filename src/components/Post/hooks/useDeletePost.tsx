import { Text } from '@mantine/core';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** Confirm, then delete a whole post from a card. Stays on the page, unlike `DeletePostButton`. */
export function useDeletePost() {
  const queryUtils = trpc.useUtils();
  const deletePostMutation = trpc.post.delete.useMutation({
    async onSuccess(_, { id }) {
      showSuccessNotification({ title: 'Post deleted', message: 'Successfully deleted post' });
      await Promise.all([
        queryUtils.post.get.invalidate({ id }),
        queryUtils.post.getInfinite.invalidate(),
        queryUtils.image.invalidate(),
      ]);
    },
    onError(error) {
      showErrorNotification({ title: 'Post delete failed', error: new Error(error.message) });
    },
  });

  return function ({ postId, imageCount }: { postId: number; imageCount?: number }) {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Delete Post',
        message: (
          <Text>
            {imageCount === undefined
              ? 'Delete this post and its images?'
              : `Delete this post and its ${imageCount} ${
                  imageCount === 1 ? 'image' : 'images'
                }?`}{' '}
            This can&apos;t be undone.
          </Text>
        ),
        labels: { cancel: 'Cancel', confirm: 'Delete Post' },
        confirmProps: { color: 'red' },
        // onError already notifies; swallowing the rejection lets the dialog close instead of
        // sticking on its spinner.
        onConfirm: () => deletePostMutation.mutateAsync({ id: postId }).catch(() => undefined),
      },
    });
  };
}
