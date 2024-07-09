import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function useQueryRecommendedResources({ modelVersionId }: { modelVersionId: number }) {
  const browsingLevel = useBrowsingLevelDebounced();
  const { data = [], ...rest } = trpc.recommenders.getResourceRecommendations.useQuery({
    modelVersionId,
    browsingLevel,
  });

  return { data, ...rest };
}

export function useToggleResourceRecommendationMutation() {
  const toggleRecommenderMutation = trpc.recommenders.toggleResourceRecommendations.useMutation({
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
