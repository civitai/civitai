import { trpc } from '~/utils/trpc';
import { showSuccessNotification } from '~/utils/notifications';

export function useUpdateCollectionCoverImage() {
  const utils = trpc.useContext();

  const updateCollectionCoverImageMutation = trpc.collection.updateCoverImage.useMutation({
    onSuccess: async () => {
      showSuccessNotification({
        title: 'Cover image updated',
        message: 'Collection cover image has been updated',
      });
    },
  });

  return async function ({ collectionId, imageId }: { collectionId: number; imageId: number }) {
    updateCollectionCoverImageMutation.mutateAsync({ id: collectionId, imageId });
    await utils.collection.getById.invalidate({ id: collectionId });
  };
}
