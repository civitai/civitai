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
    defaultValue: [],
  });

  useSignalTopic(SignalTopic.NewOrderPlayer);

  // Used to update player stats (exp, fervor, blessed buzz, rank, etc.)
  useSignalConnection(SignalMessages.NewOrderPlayerUpdate, (data) => {
    // console.log(data);
    queryUtils.games.newOrder.join.setData(undefined, (old) => {
      if (!old) return old;

      return { ...old, ...data };
    });
  });
};
