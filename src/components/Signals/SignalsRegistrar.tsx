import type { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { useBuzzSignalUpdate } from '~/components/Buzz/useBuzz';
import { useChatNewMessageSignal, useChatNewRoomSignal } from '~/components/Chat/ChatSignals';
import { useTextToImageSignalUpdate } from '~/components/ImageGeneration/utils/useGenerationSignalUpdate';
import { useNotificationSignal } from '~/components/Notifications/notifications.utils';
import { useSessionRefreshSignal } from '~/components/Signals/SessionRefreshSignal';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useMetricSignalsListener } from '~/components/Signals/MetricSignalsRegistrar';
import {
  useOrchestratorUpdateSignal,
  useTrainingSignals,
} from '~/components/Training/Form/TrainingCommon';
import { SignalMessages } from '~/server/common/enums';
import { imageStore } from '~/store/image.store';
import { useSchedulerDownloadSignal } from '~/store/scheduler-download.store';

export function SignalsRegistrar() {
  useTextToImageSignalUpdate();
  useSchedulerDownloadSignal();

  useBuzzSignalUpdate();
  useSessionRefreshSignal();

  useTrainingSignals();
  useOrchestratorUpdateSignal();

  useChatNewMessageSignal();
  useChatNewRoomSignal();

  useMetricSignalsListener();

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

  useNotificationSignal();

  return null;
}
