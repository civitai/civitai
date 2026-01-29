import type { MantineColor, NotificationProps } from '@mantine/core';
import { Notification } from '@mantine/core';
import { useInterval } from '@mantine/hooks';
import {
  createContext,
  type Dispatch,
  type SetStateAction,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { SignalMessages } from '~/server/common/enums';
import type { SignalTopic } from '~/server/common/enums';
import { useDebouncer } from '~/utils/debouncer';
import { getRandomInt } from '~/utils/number-helpers';
import type { SignalStatus } from '~/utils/signals/types';
// import { createSignalWorker, SignalWorker } from '~/utils/signals';
import type { SignalWorker } from '~/utils/signals/useSignalsWorker';
import { useSignalsWorker } from '~/utils/signals/useSignalsWorker';
import { trpc } from '~/utils/trpc';

type SignalState = {
  connected: boolean;
  status: SignalStatus | null;
  worker: SignalWorker | null;
  registeredTopics: string[];
  setRegisteredTopics: Dispatch<SetStateAction<string[]>>;
};

const signalStatusDictionary: Record<SignalStatus, MantineColor> = {
  connected: 'green',
  reconnecting: 'yellow',
  closed: 'red',
};

const SignalContext = createContext<SignalState | null>(null);
export const useSignalContext = () => {
  const context = useContext(SignalContext);
  if (!context) throw new Error('SignalContext not in tree');
  return context;
};

// Add possible types to this data structure. Leave any for safeguarding.
type SignalCallback = (data: any) => void;

export const useSignalConnection = (message: SignalMessages, cb: SignalCallback) => {
  const { worker } = useSignalContext();
  const cbRef = useRef(cb);
  // any updates to cb will be assigned to cbRef.current
  cbRef.current = cb;

  useEffect(() => {
    const callback = (args: any) => cbRef.current(args);

    worker?.on(message, callback);
    return () => {
      worker?.off(message, callback);
    };
  }, [worker, message]);
};

export const useSignalTopic = (
  topic: `${SignalTopic}${'' | `:${number | string}`}` | undefined,
  notify?: boolean
) => {
  console.log('useSignalTopic called with topic:', topic);
  const { worker, registeredTopics, setRegisteredTopics } = useSignalContext();

  const interval = useInterval(() => {
    if (!topic) return;

    console.log('Re-registering signal topic:', topic);
    worker?.topicRegister(topic, notify);
    if (!registeredTopics.includes(topic)) setRegisteredTopics((prev) => [...prev, topic]);
  }, 60000);

  useEffect(() => {
    if (topic) {
      worker?.topicRegister(topic, notify);
      if (!registeredTopics.includes(topic)) setRegisteredTopics((prev) => [...prev, topic]);
    }

    if (!!interval?.active && !!topic) {
      interval.start();
    }

    return () => {
      interval.stop();
      if (topic) {
        worker?.topicUnsubscribe(topic);
        if (registeredTopics.includes(topic))
          setRegisteredTopics((prev) => prev.filter((t) => t !== topic));
      }
    };
    // }, [interval, notify, topic, worker]);
  }, [topic, worker]);
};

const SIGNAL_DATA_REFRESH_DEBOUNCE = 10;
export function SignalProvider({ children }: { children: React.ReactNode }) {
  const queryUtils = trpc.useUtils();
  const prevStatusRef = useRef<SignalStatus | null>(null);
  const hasConnectedAtLeastOnceRef = useRef(false);
  const debounce = useDebouncer((SIGNAL_DATA_REFRESH_DEBOUNCE + getRandomInt(-2, 5)) * 1000);

  const [status, setStatus] = useState<SignalStatus | null>(null);
  prevStatusRef.current = status ?? null;
  const [registeredTopics, setRegisteredTopics] = useState<string[]>([]);

  const worker = useSignalsWorker({
    onStateChange: ({ state }) => {
      const prevStatus = prevStatusRef.current;
      const hasConnectedAtLeastOnce = hasConnectedAtLeastOnceRef.current;
      if (prevStatus !== state && state === 'connected' && hasConnectedAtLeastOnce) {
        debounce(() => {
          queryUtils.buzz.getBuzzAccount.invalidate();
          queryUtils.orchestrator.queryGeneratedImages.invalidate();
        });
      }

      if (state === 'connected') hasConnectedAtLeastOnceRef.current = true;
      setStatus(state);
    },
  });

  const connected = status === 'connected';
  console.log('SignalProvider status:', status, 'connected:', connected);

  return (
    <SignalContext.Provider
      value={{
        connected,
        status,
        worker,
        registeredTopics,
        setRegisteredTopics,
      }}
    >
      {children}
    </SignalContext.Provider>
  );
}

export function SignalStatusNotification({
  title,
  children,
  ...notificationProps
}: Omit<NotificationProps, 'children' | 'color' | 'title'> & {
  children: (status: SignalStatus) => React.ReactNode;
  title?: (status: SignalStatus) => React.ReactNode;
}) {
  const { connected, status } = useSignalContext();
  if (!status || connected) return null;

  return (
    <Notification
      {...notificationProps}
      // onClose={dismiss}
      color={signalStatusDictionary[status]}
      title={title?.(status)}
      withCloseButton={false}
    >
      {children(status)}
    </Notification>
  );
}
