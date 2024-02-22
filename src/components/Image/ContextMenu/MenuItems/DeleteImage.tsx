import { trpc } from '~/utils/trpc';

export function DeleteImage({ imageId, onSuccess }: { imageId: number; onSuccess?: () => void }) {
  const { mutate, isLoading } = trpc.image.delete.useMutation({
    async onSuccess(_, { id }) {
      await onSuccess?.(id);
      closeModal('delete-confirm');
    },
    onError(error: any) {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  return <></>;
}
