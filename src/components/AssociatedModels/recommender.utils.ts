import produce from 'immer';
import { RecommendationRequest } from '~/server/schema/recommenders.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function useQueryRecommendedResources(
  payload: Pick<RecommendationRequest, 'modelVersionId'>,
  options?: { enabled?: boolean }
) {
  const { data = [], ...rest } = trpc.recommenders.getResourceRecommendations.useQuery(
    { ...payload },
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
