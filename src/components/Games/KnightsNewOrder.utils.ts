import { useState } from 'react';
import { ImageProps } from '~/components/ImageViewer/ImageViewer';
import { useSignalConnection, useSignalTopic } from '~/components/Signals/SignalsProvider';
import { useStorage } from '~/hooks/useStorage';
import { SignalMessages, SignalTopic } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';

// TODO.newOrder: complete signal setup
export const useKnightsNewOrderListener = () => {
  const queryUtils = trpc.useUtils();
  const [imagesQueue, setImagesQueue] = useStorage({
    key: 'kono-image-queue',
    type: 'localStorage',
    defaultValue: [] as ImageProps[],
  });

  useSignalTopic(SignalTopic.NewOrderPlayer);
  useSignalTopic(SignalTopic.NewOrderQueue);

  // Used to update player stats (exp, fervor, blessed buzz, rank, etc.)
  useSignalConnection(SignalMessages.NewOrderPlayerUpdate, (data) => {
    // console.log(data);
    queryUtils.games.newOrder.getPlayer.setData(undefined, (old) => {
      if (!old) return old;

      return { ...old, ...data };
    });
  });

  // Used to update the current image queue
  useSignalConnection(SignalMessages.NewOrderQueueUpdate, (data) => {
    // console.log(data);
    setImagesQueue((old) => [...old, ...data]);
  });
};

export const useJoinKnightsNewOrder = () => {
  const queryUtils = trpc.useUtils();
  const [joined, setJoined] = useState(false);

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
  };
};
