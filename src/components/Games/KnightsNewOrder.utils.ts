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

  useSignalTopic(SignalTopic.NewOrder);

  useSignalConnection(SignalMessages.NewOrderQueueUpdate, (data) => {
    console.log(data);
  });
};
