import produce from 'immer';

import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Model3DGallerySettingsResolved = {
  hiddenUsers: Array<{ id: number; username: string | null }>;
  hiddenTags: Array<{ id: number; name: string }>;
  hiddenImages: number[];
};

/**
 * Read + mutate per-Model gallery moderation settings.
 *
 * `modelId` is optional: pass `undefined` from non-Model gallery contexts
 * (e.g. Model3D) to disable the underlying query. Toggle/copy mutations are
 * still wired but only meaningful from a Model gallery.
 */
export const useGallerySettings = ({ modelId }: { modelId?: number }) => {
  const queryUtils = trpc.useUtils();
  const { data, isLoading } = trpc.model.getGallerySettings.useQuery(
    { id: modelId ?? 0 },
    { enabled: !!modelId }
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
  const handleToggleSettings = async ({
    modelId,
    tags,
    users,
    level,
    hiddenImages,
    pinnedPosts,
  }: {
    modelId: number;
    tags?: Array<{ id: number; name: string }>;
    users?: Array<{ id: number; username: string | null }>;
    level?: number;
    hiddenImages?: { modelVersionId: number; imageIds: number[] };
    pinnedPosts?: { modelVersionId: number; postIds: number[] };
  }) => {
    if (!data) return;
    const updatedSettings = {
      hiddenImages: hiddenImages
        ? hiddenImages.imageIds.some((id) => {
            const versionHiddenImages = data.hiddenImages?.[hiddenImages.modelVersionId] ?? [];
            return versionHiddenImages.includes(id);
          })
          ? {
              ...data.hiddenImages,
              [hiddenImages.modelVersionId]:
                data.hiddenImages?.[hiddenImages.modelVersionId]?.filter(
                  (id) => !hiddenImages.imageIds.includes(id)
                ) ?? [],
            }
          : {
              ...data.hiddenImages,
              [hiddenImages.modelVersionId]: [
                ...(data.hiddenImages?.[hiddenImages.modelVersionId] ?? []),
                ...hiddenImages.imageIds,
              ],
            }
        : data?.hiddenImages ?? {},
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

  const copyGallerySettingsMutations = trpc.model.copyGallerySettings.useMutation({
    onSuccess: async () => {
      await queryUtils.model.getGallerySettings.invalidate({ id: modelId });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Unable to copy gallery moderation preferences',
        error: new Error(error.message),
      });
    },
  });

  const handleCopyGallerySettings = async (modelId: number) => {
    await copyGallerySettingsMutations.mutateAsync({ id: modelId });
  };

  return {
    gallerySettings: data,
    loading: isLoading,
    toggle: handleToggleSettings,
    updating: updateGallerySettingsMutation.isPending,
    copySettings: handleCopyGallerySettings,
    copySettingsLoading: copyGallerySettingsMutations.isPending,
  };
};

/**
 * Read + mutate per-Model3D gallery moderation settings. Mirrors
 * `useGallerySettings` (Model) but with a flat `hiddenImages: number[]` —
 * Model3D has no version dimension. No `pinnedPosts` or `level` for v1.
 *
 * `model3dId` is optional: passing `undefined` from non-Model3D contexts
 * disables the underlying query cleanly.
 */
export const useModel3DGallerySettings = ({ model3dId }: { model3dId?: number }) => {
  const queryUtils = trpc.useUtils();
  const { data, isLoading } = trpc.model3d.getGallerySettings.useQuery(
    { id: model3dId ?? 0 },
    { enabled: !!model3dId }
  );

  const updateMutation = trpc.model3d.updateGallerySettings.useMutation({
    onMutate: async (payload) => {
      const id = payload.id;
      await queryUtils.model3d.getGallerySettings.cancel({ id });
      await queryUtils.image.getImagesAsPostsInfinite.cancel();
      const previous = queryUtils.model3d.getGallerySettings.getData({ id });
      if (payload.gallerySettings) {
        queryUtils.model3d.getGallerySettings.setData(
          { id },
          produce((draft) =>
            draft
              ? {
                  ...draft,
                  hiddenUsers: payload.gallerySettings!.hiddenUsers,
                  hiddenTags: payload.gallerySettings!.hiddenTags,
                  hiddenImages: payload.gallerySettings!.hiddenImages,
                }
              : draft
          )
        );
      }
      return { previous };
    },
    onError: (error, { id }, context) => {
      showErrorNotification({
        title: 'Unable to update gallery settings',
        error: new Error(error.message),
      });
      queryUtils.model3d.getGallerySettings.setData({ id }, context?.previous);
    },
  });

  const handleToggle = async ({
    model3dId,
    tags,
    users,
    hiddenImages,
  }: {
    model3dId: number;
    tags?: Array<{ id: number; name: string }>;
    users?: Array<{ id: number; username: string | null }>;
    hiddenImages?: number[];
  }) => {
    if (!data) return;
    const next: Model3DGallerySettingsResolved = {
      hiddenImages: hiddenImages
        ? hiddenImages.some((id) => data.hiddenImages.includes(id))
          ? data.hiddenImages.filter((id) => !hiddenImages.includes(id))
          : [...data.hiddenImages, ...hiddenImages]
        : data.hiddenImages,
      hiddenTags: tags
        ? tags.some((x) => data.hiddenTags.map((y) => y.id).includes(x.id))
          ? data.hiddenTags.filter((x) => !tags.find((t) => t.id === x.id))
          : [...data.hiddenTags, ...tags]
        : data.hiddenTags,
      hiddenUsers: users
        ? users.some((x) => data.hiddenUsers.map((y) => y.id).includes(x.id))
          ? data.hiddenUsers.filter((x) => !users.find((u) => u.id === x.id))
          : [...data.hiddenUsers, ...users]
        : data.hiddenUsers,
    };
    return updateMutation.mutateAsync({ id: model3dId, gallerySettings: next });
  };

  return {
    gallerySettings: data,
    loading: isLoading,
    toggle: handleToggle,
    updating: updateMutation.isPending,
  };
};
