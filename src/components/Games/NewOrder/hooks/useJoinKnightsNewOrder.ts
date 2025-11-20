import { useIsMutating } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { useStorage } from '~/hooks/useStorage';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';

export const useJoinKnightsNewOrder = () => {
  const queryUtils = trpc.useUtils();
  const [joined, setJoined] = useStorage({
    key: 'joined-kono',
    type: 'localStorage',
    defaultValue: false,
    getInitialValueInEffect: false,
  });
  const [viewedRatingGuide, setViewedRatingGuide] = useStorage({
    key: 'kono-rating-guide',
    type: 'localStorage',
    defaultValue: false,
    getInitialValueInEffect: false,
  });

  // Required to share loading state between components
  const joinKey = getQueryKey(trpc.games.newOrder.join);
  const joining = useIsMutating({ mutationKey: joinKey });

  const joinKnightsNewOrderMutation = trpc.games.newOrder.join.useMutation({
    onSuccess: (result) => {
      queryUtils.games.newOrder.getPlayer.setData(undefined, (old) => {
        setJoined(true);
        if (!old) return result;

        return { ...old, ...result };
      });
    },
  });

  const { data: playerData, isInitialLoading } = trpc.games.newOrder.getPlayer.useQuery(undefined, {
    enabled: joined,
    retry: 1,
    onError: (error) => {
      setJoined(false);
      showErrorNotification({
        title: 'Failed to load player data',
        error: new Error(error.message),
      });
    },
  });

  const resetCareerMutation = trpc.games.newOrder.resetCareer.useMutation({
    onSuccess: async () => {
      await Promise.all([
        queryUtils.games.newOrder.getPlayer.invalidate(),
        queryUtils.games.newOrder.getImagesQueue.invalidate(),
        queryUtils.games.newOrder.getHistory.invalidate(),
      ]);
    },
  });

  return {
    playerData,
    join: joinKnightsNewOrderMutation.mutateAsync,
    resetCareer: resetCareerMutation.mutateAsync,
    isLoading: isInitialLoading || !!joining,
    resetting: resetCareerMutation.isLoading,
    joined,
    viewedRatingGuide,
    setViewedRatingGuide,
  };
};
