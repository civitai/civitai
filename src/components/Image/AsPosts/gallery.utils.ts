import produce from 'immer';

import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const useGallerySettings = ({ modelId }: { modelId: number }) => {
  const queryUtils = trpc.useUtils();
  const { data, isLoading } = trpc.model.getGallerySettings.useQuery({ id: modelId });

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
  const handleToggleSettings = async ({
    modelId,
    images,
    tags,
    users,
    level,
    pinnedPosts,
  }: {
    modelId: number;
    images?: Array<{ id: number }>;
    tags?: Array<{ id: number; name: string }>;
    users?: Array<{ id: number; username: string | null }>;
    level?: number;
    pinnedPosts?: { modelVersionId: number; postIds: number[] };
  }) => {
    if (!data) return;
    const updatedSettings = {
      hiddenImages: images
        ? images.some((x) => data.hiddenImages.includes(x.id))
          ? data.hiddenImages.filter((x) => !images.find((i) => i.id === x))
          : [...data.hiddenImages, ...images.map((x) => x.id)]
        : data?.hiddenImages ?? [],
      hiddenTags: tags
        ? tags.some((x) => data.hiddenTags.map((x) => x.id).includes(x.id))
          ? data.hiddenTags.filter((x) => !tags.find((t) => t.id === x.id))
          : [...data.hiddenTags, ...tags]
        : data?.hiddenTags ?? [],
      hiddenUsers: users
        ? users.some((x) => data.hiddenUsers.map((x) => x.id).includes(x.id))
          ? data.hiddenUsers.filter((x) => !users.find((u) => u.id === x.id))
          : [...data.hiddenUsers, ...users]
        : data?.hiddenUsers ?? [],
      level: level ?? data?.level,
      pinnedPosts: pinnedPosts
        ? pinnedPosts.postIds.some((id) => {
            const versionPinnedPosts = data.pinnedPosts?.[pinnedPosts.modelVersionId] ?? [];
            return versionPinnedPosts.includes(id);
          })
          ? {
              ...data.pinnedPosts,
              [pinnedPosts.modelVersionId]:
                data.pinnedPosts?.[pinnedPosts.modelVersionId]?.filter(
                  (id) => !pinnedPosts.postIds.includes(id)
                ) ?? [],
            }
          : {
              ...data.pinnedPosts,
              [pinnedPosts.modelVersionId]: [
                ...(data.pinnedPosts?.[pinnedPosts.modelVersionId] ?? []),
                ...pinnedPosts.postIds,
              ],
            }
        : data?.pinnedPosts ?? {},
    };

    return updateGallerySettingsMutation.mutateAsync({
      id: modelId,
      gallerySettings: updatedSettings,
    });
  };

  return {
    gallerySettings: data,
    loading: isLoading,
    toggle: handleToggleSettings,
    updating: updateGallerySettingsMutation.isLoading,
  };
};
