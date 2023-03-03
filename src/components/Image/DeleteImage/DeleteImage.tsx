import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { openConfirmModal } from '@mantine/modals';

export function DeleteImage({
  children,
  imageId,
  onSuccess,
}: {
  imageId: number;
  children: ({
    onClick,
    isLoading,
  }: {
    onClick: () => void;
    isLoading: boolean;
  }) => React.ReactElement;
  onSuccess?: (imageId: number) => void;
}) {
  const { mutate, isLoading } = trpc.image.delete.useMutation({
    async onSuccess(_, { id }) {
      await onSuccess?.(id);
    },
    onError(error: any) {
      showErrorNotification({ error: new Error(error.message) });
    },
  });
  const onClick = () => {
    openConfirmModal({
      centered: true,
      title: 'Delete image',
      children: 'Are you sure you want to delete this image?',
      labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
      confirmProps: { color: 'red' },
      onConfirm: () => mutate({ id: imageId }),
    });
  };

  return children({ onClick, isLoading });
}
