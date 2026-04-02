import dynamic from 'next/dynamic';
import type { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { useBuzzSignalUpdate } from '~/components/Buzz/useBuzz';
import { useCryptoDepositSignal } from '~/components/Signals/CryptoDepositSignal';
import { useChatNewMessageSignal, useChatNewRoomSignal } from '~/components/Chat/ChatSignals';
import { useNotificationSignal } from '~/components/Notifications/notifications.utils';
import { useSessionRefreshSignal } from '~/components/Signals/SessionRefreshSignal';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useMetricSignalsListener } from '~/components/Signals/MetricSignalsRegistrar';
import { useSignalRegistry } from '~/components/Signals/signals-registry.store';
import { SignalMessages } from '~/server/common/enums';
import { imageStore } from '~/store/image.store';
import { useSchedulerDownloadSignal } from '~/store/scheduler-download.store';

const TrainingSignals = dynamic(
  () => import('~/components/Signals/TrainingSignals').then((m) => ({ default: m.TrainingSignals })),
  { ssr: false }
);
const GenerationSignals = dynamic(
  () =>
    import('~/components/Signals/GenerationSignals').then((m) => ({
      default: m.GenerationSignals,
    })),
  { ssr: false }
);

export function SignalsRegistrar() {
  const groups = useSignalRegistry((s) => s.groups);

  useSchedulerDownloadSignal();

  useBuzzSignalUpdate();
  useSessionRefreshSignal();

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

  useCryptoDepositSignal();

  return (
    <>
      {groups.has('training') && <TrainingSignals />}
      {groups.has('generation') && <GenerationSignals />}
    </>
  );
}
