import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { closeModal, openConfirmModal } from '@mantine/modals';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { imageStore } from '~/store/image.store';

export function UnblockImage({
  children,
  imageId,
  onSuccess,
  skipConfirm,
  closeOnConfirm = false,
  onUnblock,
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
  skipConfirm?: boolean;
  closeOnConfirm?: boolean;
  onUnblock?: (imageId: number) => void;
}) {
  const currentUser = useCurrentUser();
  const { mutate, isLoading } = trpc.image.moderate.useMutation({
    async onSuccess(_, { ids: [id] }) {
      imageStore.setImage(imageId, { ingestion: 'Scanned', blockedFor: undefined });
      await onSuccess?.(id);
      closeModal('unblock-confirm');
    },
    onError(error: any) {
      showErrorNotification({ error: new Error(error.message) });
    },
  });
  if (!currentUser?.isModerator) return null;
  const onClick = () => {
    if (skipConfirm) {
      mutate({ ids: [imageId], reviewType: 'blocked' });
    } else {
      openConfirmModal({
        modalId: 'unblock-confirm',
        centered: true,
        title: 'Unblock image',
        children: 'Are you sure you want to unblock this image?',
        labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
        closeOnConfirm,
        onConfirm: () => {
          mutate({ ids: [imageId], reviewType: 'blocked' });
          onUnblock?.(imageId);
        },
        zIndex: 1000,
      });
    }
  };

  return children({ onClick, isLoading });
}
