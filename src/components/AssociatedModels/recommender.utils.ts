import produce from 'immer';
import { useMemo } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { GetAssociatedResourcesInput } from '~/server/schema/model.schema';
import type { RecommendationRequest } from '~/server/schema/recommenders.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function useQueryRecommendedResources(
  payload: Omit<GetAssociatedResourcesInput, 'browsingLevel'> &
    Pick<RecommendationRequest, 'modelVersionId'>
) {
  const { fromId, modelVersionId, type } = payload;
  const browsingLevel = useBrowsingLevelDebounced();
  const features = useFeatureFlags();

  const { data: associatedModels = [], isLoading: loadingAssociated } =
    trpc.model.getAssociatedResourcesCardData.useQuery({
      fromId,
      type,
      browsingLevel,
    });
  const { data: recommendedResources = [], isLoading: loadingRecommended } =
    trpc.recommenders.getResourceRecommendations.useQuery(
      { modelVersionId, browsingLevel },
      { enabled: !!modelVersionId && features.recommenders }
    );

  // Memoize combined data to prevent unnecessary re-renders
  const combinedData = useMemo(
    () => [...associatedModels, ...recommendedResources],
    [associatedModels, recommendedResources]
  );

  // Partition data by resourceType for appropriate filtering
  const modelItems = useMemo(
    () =>
      combinedData.filter(
        (item) => item.resourceType === 'model' || item.resourceType === 'recommended'
      ),
    [combinedData]
  );

  const articleItems = useMemo(
    () => combinedData.filter((item) => item.resourceType === 'article'),
    [combinedData]
  );

  // Apply hidden preferences to models (including 'recommended' type)
  const {
    items: filteredModels,
    hiddenCount: modelsHiddenCount,
    loadingPreferences: modelsLoading,
  } = useApplyHiddenPreferences({ type: 'models', data: modelItems });

  // Apply hidden preferences to articles
  const {
    items: filteredArticles,
    hiddenCount: articlesHiddenCount,
    loadingPreferences: articlesLoading,
  } = useApplyHiddenPreferences({ type: 'articles', data: articleItems });

  // Merge filtered results
  const filteredResources = useMemo(
    () => [...filteredModels, ...filteredArticles],
    [filteredModels, filteredArticles]
  );

  return {
    recommendedResources: filteredResources,
    hiddenCount: modelsHiddenCount + articlesHiddenCount,
    isLoading: loadingAssociated || loadingRecommended || modelsLoading || articlesLoading,
  };
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
    isLoading: toggleRecommenderMutation.isPending,
  };
}
