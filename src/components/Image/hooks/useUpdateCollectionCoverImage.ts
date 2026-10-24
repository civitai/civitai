import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function useUpdateCollectionCoverImage() {
  const utils = trpc.useUtils();

  const updateCollectionCoverImageMutation = trpc.collection.updateCoverImage.useMutation({
    onSuccess: async (_, { id }) => {
      showSuccessNotification({
        title: 'Cover image updated',
        message: 'Collection cover image has been updated',
      });
      await utils.collection.getById.invalidate({ id });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Unable to update cover image',
        error: new Error(error.message),
      });
    },
  });

  return function ({ collectionId, imageId }: { collectionId: number; imageId: number }) {
    updateCollectionCoverImageMutation.mutate({ id: collectionId, imageId });
  };
}
