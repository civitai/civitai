import { ImageIngestionStatus } from '@prisma/client';
import { useBuzzSignalUpdate } from '~/components/Buzz/useBuzz';
import { useChatNewMessageSignal, useChatNewRoomSignal } from '~/components/Chat/ChatSignals';
import { useTextToImageSignalUpdate } from '~/components/ImageGeneration/utils/generationRequestHooks';
import {
  useOrchestratorUpdateSignal,
  useTrainingSignals,
} from '~/components/Training/Form/TrainingCommon';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { imageStore } from '~/store/image.store';

export function SignalsRegistrar() {
  useTextToImageSignalUpdate();

  useBuzzSignalUpdate();

  useTrainingSignals();
  useOrchestratorUpdateSignal();

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
