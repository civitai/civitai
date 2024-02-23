import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ConfirmDialog } from '~/components/Dialog/Common/ConfirmDialog';
import { Menu } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';

export function DeleteImage({
  imageId,
  skipConfirm,
  onSuccess,
  onMutate,
}: {
  imageId: number;
  skipConfirm?: boolean;
  onSuccess?: () => void;
  onMutate?: () => void;
}) {
  const { mutateAsync, isLoading } = trpc.image.delete.useMutation({
    onMutate,
    onSuccess,
    onError(error: any) {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const handleClick = () => {
    if (skipConfirm) mutateAsync({ id: imageId });
    else
      dialogStore.trigger({
        component: ConfirmDialog,
        props: {
          title: 'Delete image',
          message: 'Are you sure you want to delete this image?',
          labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
          confirmProps: { color: 'red', loading: isLoading },
          onConfirm: async () => await mutateAsync({ id: imageId }),
        },
      });
  };

  return (
    <Menu.Item color="red" icon={<IconTrash size={14} stroke={1.5} />} onClick={handleClick}>
      Delete
    </Menu.Item>
  );
}
