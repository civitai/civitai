import { useSignalConnection, useSignalTopic } from '~/components/Signals/SignalsProvider';
import { useStorage } from '~/hooks/useStorage';
import {
  NewOrderDamnedReason,
  NsfwLevel,
  SignalMessages,
  SignalTopic,
} from '~/server/common/enums';
import { AddImageRatingInput } from '~/server/schema/games/new-order.schema';
import { browsingLevels } from '~/shared/constants/browsingLevel.constants';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

// TODO.newOrder: complete signal setup
export const useKnightsNewOrderListener = () => {
  const queryUtils = trpc.useUtils();

  useSignalTopic(SignalTopic.NewOrderPlayer);
  useSignalTopic(SignalTopic.NewOrderQueue);

  // Used to update player stats (exp, fervor, blessed buzz, rank, etc.)
  useSignalConnection(SignalMessages.NewOrderPlayerUpdate, (data) => {
    queryUtils.games.newOrder.getPlayer.setData(undefined, (old) => {
      if (!old) return old;

      return { ...old, ...data };
    });
  });

  // Used to update the current image queue
  useSignalConnection(SignalMessages.NewOrderQueueUpdate, (data) => {
    queryUtils.games.newOrder.getImagesQueue.setData({ limit: 100 }, (old) => {
      if (!old) return old;

      return [...old, ...data];
    });
  });
};

export const useJoinKnightsNewOrder = () => {
  const queryUtils = trpc.useUtils();
  const [joined, setJoined] = useStorage({
    key: 'joined-kono',
    type: 'localStorage',
    defaultValue: false,
  });

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
  });

  return {
    playerData,
    joinKnightsNewOrder: joinKnightsNewOrderMutation.mutateAsync,
    isLoading: isInitialLoading || joinKnightsNewOrderMutation.isLoading,
    joined,
  };
};

export const useQueryKnightsNewOrderImageQueue = (opts?: { enabled?: boolean }) => {
  const { playerData } = useJoinKnightsNewOrder();

  const { data = [], isLoading } = trpc.games.newOrder.getImagesQueue.useQuery(
    { limit: 100 },
    { ...opts, enabled: !!playerData && opts?.enabled !== false }
  );

  return { data, isLoading };
};

export const useAddImageRatingMutation = () => {
  const queryUtils = trpc.useUtils();
  const addRatingMutation = trpc.games.newOrder.addRating.useMutation({
    onSuccess: (_, payload) => {
      queryUtils.games.newOrder.getImagesQueue.setData({ limit: 100 }, (old) => {
        if (!old) return old;

        return old.filter((image) => image.id !== payload.imageId);
      });
    },
    onError: (error) => {
      showErrorNotification({ title: 'Failed to send rating', error: new Error(error.message) });
    },
  });

  const handleAddRating = (input: Omit<AddImageRatingInput, 'playerId'>) => {
    return addRatingMutation.mutateAsync(input);
  };

  return { addRating: handleAddRating, isLoading: addRatingMutation.isLoading };
};

export const ratingOptions = [...browsingLevels, NsfwLevel.Blocked];

export const damnedReasonOptions = [
  NewOrderDamnedReason.InappropriateMinors,
  NewOrderDamnedReason.RealisticMinors,
  NewOrderDamnedReason.InappropriateRealPerson,
  NewOrderDamnedReason.Bestiality,
  NewOrderDamnedReason.GraphicViolence,
] as const;
