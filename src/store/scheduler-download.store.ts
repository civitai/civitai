import { create } from 'zustand';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';

export const useSchedulerDownloadingStore = create<{ downloading: boolean }>(() => ({
  downloading: false,
}));

export function useSchedulerDownloadSignal() {
  useSignalConnection(
    SignalMessages.SchedulerDownload,
    ({ downloading }: { downloading: boolean }) => {
      useSchedulerDownloadingStore.setState({ downloading });
    }
  );
}
