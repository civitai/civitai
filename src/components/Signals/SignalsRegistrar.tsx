import { ImageIngestionStatus } from '@prisma/client';
import { useBuzzSignalUpdate } from '~/components/Buzz/useBuzz';
import { useChatNewMessageSignal, useChatNewRoomSignal } from '~/components/Chat/ChatSignals';
import { useImageGenStatusUpdate } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useTrainingSignals } from '~/components/Resource/Forms/Training/TrainingCommon';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { imageStore } from '~/store/image.store';

export function SignalsRegistrar() {
  useImageGenStatusUpdate();
  useTrainingSignals();
  useBuzzSignalUpdate();

  useChatNewMessageSignal();
  useChatNewRoomSignal();

  useSignalConnection(
    SignalMessages.ImageIngestionStatus,
    ({
      imageId,
      ingestion,
      blockedFor,
    }: {
      imageId: number;
      ingestion: ImageIngestionStatus;
      blockedFor?: string;
    }) => {
      imageStore.setImage(imageId, { ingestion, blockedFor });
    }
  );

  return null;
}
