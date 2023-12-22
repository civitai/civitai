import { trpc } from '~/utils/trpc';
import produce from 'immer';
import { showErrorNotification } from '~/utils/notifications';
import { useMemo } from 'react';

export const useModelGallerySettings = ({ modelId }: { modelId: number }) => {
  const queryUtils = trpc.useContext();

  const { data = { hiddenTags: [], hiddenUsers: [], hiddenImages: [] }, isLoading } =
    trpc.model.getGallerySettings.useQuery({ id: modelId });

  const hiddenTags = useMemo(
    () => new Map(data?.hiddenTags.map((x) => [x.id, true])) ?? [],
    [data?.hiddenTags]
  );
  const hiddenUsers = useMemo(
    () => new Map(data?.hiddenUsers.map((x) => [x.id, true])) ?? [],
    [data?.hiddenUsers]
  );
  const hiddenImages = useMemo(
    () => new Map(data?.hiddenImages.map((x) => [x, true])) ?? [],
    [data?.hiddenImages]
  );

  const updateGallerySettingsMutation = trpc.model.updateGallerySettings.useMutation({
    onMutate: async (payload) => {
      const { id, gallerySettings } = payload;
      await queryUtils.model.getGallerySettings.cancel({ id });
      await queryUtils.image.getImagesAsPostsInfinite.cancel();

      const previousSettings = queryUtils.model.getGallerySettings.getData({ id });
      queryUtils.model.getGallerySettings.setData(
        { id },
        produce((draft) => (draft ? { ...draft, ...gallerySettings } : draft))
      );

      return { previousSettings };
    },
    onError: (error, { id }, context) => {
      showErrorNotification({
        title: 'Unable to update gallery settings',
        error: new Error(error.message),
      });
      queryUtils.model.getGallerySettings.setData({ id }, context?.previousSettings);
    },
  });

  const handleUpdateGallerySettings = async ({
    modelId,
    images,
    tags,
    users,
  }: {
    modelId: number;
    images?: Array<{ id: number }>;
    tags?: Array<{ id: number; name: string }>;
    users?: Array<{ id: number; username: string | null }>;
  }) => {
    const updatedSettings = {
      hiddenImages:
        images && data?.hiddenImages
          ? images.some((x) => hiddenImages.get(x.id))
            ? data.hiddenImages.filter((x) => !images.find((i) => i.id === x))
            : [...data.hiddenImages, ...images.map((x) => x.id)]
          : data?.hiddenImages ?? [],
      hiddenTags:
        tags && data?.hiddenTags
          ? tags.some((x) => hiddenTags.get(x.id))
            ? data.hiddenTags.filter((x) => !tags.find((t) => t.id === x.id))
            : [...data.hiddenTags, ...tags]
          : data?.hiddenTags ?? [],
      hiddenUsers:
        users && data?.hiddenUsers
          ? users.some((x) => hiddenUsers.get(x.id))
            ? data.hiddenUsers.filter((x) => !users.find((u) => u.id === x.id))
            : [...data.hiddenUsers, ...users]
          : data?.hiddenUsers ?? [],
    };

    return updateGallerySettingsMutation.mutateAsync({
      id: modelId,
      gallerySettings: updatedSettings,
    });
  };

  return {
    data,
    isLoading,
    hiddenTags,
    hiddenUsers,
    hiddenImages,
    toggleGallerySettings: handleUpdateGallerySettings,
    updating: updateGallerySettingsMutation.isLoading,
  };
};
