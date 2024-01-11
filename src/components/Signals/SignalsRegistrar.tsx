import { useImageGenStatusUpdate } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useTrainingSignals } from '~/components/Resource/Forms/Training/TrainingCommon';
import { useBuzzSignalUpdate } from '~/components/Buzz/useBuzz';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { ImageIngestionStatus } from '@prisma/client';
import { imageStore } from '~/store/image.store';

export function SignalsRegistrar() {
  useImageGenStatusUpdate();
  useTrainingSignals();
  useBuzzSignalUpdate();

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
