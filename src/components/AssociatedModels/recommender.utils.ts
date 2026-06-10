import { useMemo } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import type { GetAssociatedResourcesInput } from '~/server/schema/model.schema';
import { trpc } from '~/utils/trpc';

export function useQueryRecommendedResources(
  payload: Omit<GetAssociatedResourcesInput, 'browsingLevel'>
) {
  const { fromId, type } = payload;
  const browsingLevel = useBrowsingLevelDebounced();

  const {
    data: associatedModels = [],
    isLoading: loadingAssociated,
    isRefetching: refetchingAssociated,
  } = trpc.model.getAssociatedResourcesCardData.useQuery({
    fromId,
    type,
    browsingLevel,
  });

  // Partition data by resourceType for appropriate filtering
  const modelItems = useMemo(
    () => associatedModels.filter((item) => item.resourceType === 'model'),
    [associatedModels]
  );

  const articleItems = useMemo(
    () => associatedModels.filter((item) => item.resourceType === 'article'),
    [associatedModels]
  );

  // Apply hidden preferences to models
  const {
    items: filteredModels,
    hiddenCount: modelsHiddenCount,
    loadingPreferences: modelsLoading,
  } = useApplyHiddenPreferences({
    type: 'models',
    data: modelItems,
    isRefetching: refetchingAssociated,
  });

  // Apply hidden preferences to articles
  const {
    items: filteredArticles,
    hiddenCount: articlesHiddenCount,
    loadingPreferences: articlesLoading,
  } = useApplyHiddenPreferences({
    type: 'articles',
    data: articleItems,
    isRefetching: refetchingAssociated,
  });

  // Merge filtered results
  const filteredResources = useMemo(
    () => [...filteredModels, ...filteredArticles],
    [filteredModels, filteredArticles]
  );

  return {
    recommendedResources: filteredResources,
    hiddenCount: modelsHiddenCount + articlesHiddenCount,
    isLoading: loadingAssociated || modelsLoading || articlesLoading,
  };
}
