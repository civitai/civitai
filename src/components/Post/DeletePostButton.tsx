import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { Text } from '@mantine/core';
import { useRouter } from 'next/router';

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
  const queryUtils = trpc.useContext();
  const { mutate, isLoading } = trpc.post.delete.useMutation({
    async onSuccess(_, { id }) {
      router.push('/').then(() => {
        queryUtils.post.get.invalidate({ id });
        // TODO.posts - invalidate any other post caches
        // TODO.posts - figure out why deleting and changing route causes this error: `Rendered fewer hooks than expected`
      });
    },
    onError(error: any) {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const onClick = () => {
    openConfirmModal({
      centered: true,
      title: 'Delete post',
      children: (
        <Text>
          Are you sure you want to delete this post? The images in this post{' '}
          <strong>will not be deleted</strong> from your account.
        </Text>
      ),
      labels: { cancel: `Cancel`, confirm: `Delete Post Only` },
      confirmProps: { color: 'red' },
      onConfirm: () => mutate({ id: postId }),
    });
  };

  return children({ onClick, isLoading });
}
