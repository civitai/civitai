import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { Text } from '@mantine/core';
import { useRouter } from 'next/router';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ConfirmDialog } from '~/components/Dialog/Common/ConfirmDialog';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function DeletePostButton({
  children,
  postId,
}: {
  postId: number;
  children: ({
    onClick,
    isLoading,
  }: {
    onClick: () => void;
    isLoading: boolean;
  }) => React.ReactElement;
}) {
  const router = useRouter();
  const returnUrl = (router.query.returnUrl as string) ?? '/';
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const { mutate, isLoading } = trpc.post.delete.useMutation({
    async onSuccess(_, { id }) {
      // router.push('/posts');
      showSuccessNotification({
        title: 'Post deleted',
        message: 'Successfully deleted post',
      });
      if (returnUrl) router.replace(returnUrl);
      else if (currentUser?.username) router.replace(`/user/${currentUser.username}/posts`);
      else router.replace('/posts');

      await router.replace(returnUrl);
      await queryUtils.post.get.invalidate({ id });
      await queryUtils.post.getInfinite.invalidate();
    },
    onError(error) {
      showErrorNotification({ title: 'Post delete failed', error: new Error(error.message) });
    },
  });

  const onClick = () => {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Delete Post',
        message: (
          <Text>
            Are you sure you want to delete this post? The images in this post{' '}
            <strong>will also be deleted</strong>.
          </Text>
        ),
        labels: { cancel: `Cancel`, confirm: `Delete Post` },
        confirmProps: { color: 'red' },
        onConfirm: () => {
          mutate({ id: postId });
        },
      },
    });
  };

  return children({ onClick, isLoading });
}
