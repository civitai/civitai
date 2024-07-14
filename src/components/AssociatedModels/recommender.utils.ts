import produce from 'immer';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { Flags } from '~/shared/utils';



export function useQueryRecommendedResources(
  { modelVersionId, modelId }: { modelVersionId: number, modelId: number },
  options?: { enabled?: boolean }
) {
  const browsingLevel = useBrowsingLevelDebounced();
  const gallerySettings = trpc.model.getGallerySettings.useQuery({ id: modelId }).data;
  let intersection = browsingLevel;
  if (gallerySettings?.level) {
    intersection = Flags.intersection(browsingLevel, gallerySettings.level);
  }
  const { data = [], ...rest } = trpc.recommenders.getResourceRecommendations.useQuery(
    { modelVersionId, browsingLevel: intersection },
    options
  );
  return { data, ...rest };
}

export function useToggleResourceRecommendationMutation() {
  const queryUtils = trpc.useUtils();
  const toggleRecommenderMutation = trpc.recommenders.toggleResourceRecommendations.useMutation({
    onSuccess: async (result) => {
      queryUtils.model.getById.setData(
        { id: result.modelId },
        produce((model) => {
          if (!model) return model;

          const affectedVersion = model.modelVersions.find((v) => v.id === result.id);
          if (!affectedVersion) return model;

          affectedVersion.meta.allowAIRecommendations = result.meta.allowAIRecommendations;
        })
      );
      await queryUtils.recommenders.getResourceRecommendations.invalidate({
        modelVersionId: result.id,
      });
    },
    onError: (error) => {
      showErrorNotification({ title: 'Failed to save', error: new Error(error.message) });
    },
  });

  const handleToggle = ({ resourceId }: { resourceId: number }) => {
    return toggleRecommenderMutation.mutateAsync({ id: resourceId });
  };

  return {
    toggleResourceRecommendation: handleToggle,
    isLoading: toggleRecommenderMutation.isLoading,
  };
}
