import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { trpc } from '~/utils/trpc';
import { SignalMessages } from '~/server/common/enums';
import { useSession } from 'next-auth/react';
import { SignalNotifications } from '~/components/Signals/SignalsNotifications';
import { SignalsRegistrar } from '~/components/Signals/SignalsRegistrar';
import { SignalWorker, createSignalWorker } from '~/utils/signals';
import { MantineColor, Notification, NotificationProps } from '@mantine/core';
import { useInterval } from '@mantine/hooks';

type SignalState = {
  connected: boolean;
  connectionError: boolean;
  reconnecting: boolean;
  closed: boolean;
  status?: SignalStatus;
  worker: SignalWorker | null;
};

type SignalStatus = 'connected' | 'reconnecting' | 'error' | 'closed';
const signalStatusDictionary: Record<SignalStatus, MantineColor> = {
  connected: 'green',
  reconnecting: 'yellow',
  error: 'red',
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
  const { connected, worker } = useSignalContext();
  const cbRef = useRef(cb);
  // any updates to cb will be assigned to cbRef.current
  cbRef.current = cb;

  useEffect(() => {
    const callback = (args: any) => cbRef.current(args);

    if (connected && worker) {
      worker.on(message, callback);
    }

    return () => {
      worker?.off(message, callback);
    };
  }, [connected, worker, message]);
};

export function SignalProvider({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const queryUtils = trpc.useContext();
  const [status, setStatus] = useState<'connected' | 'reconnecting' | 'error' | 'closed'>();
  const workerRef = useRef<SignalWorker | null>(null);
  if (!workerRef.current && typeof window !== 'undefined')
    workerRef.current = createSignalWorker({
      onConnected: () => {
        console.debug('SignalsProvider :: signal service connected'); // eslint-disable-line no-console
        setStatus((prevStatus) => {
          if (prevStatus === 'closed' || prevStatus === 'error')
            queryUtils.orchestrator.queryGeneratedImages.invalidate();
          return 'connected';
        });
      },
      onReconnected: () => {
        console.debug('signal service reconnected'); // eslint-disable-line no-console
        if (userId) {
          queryUtils.buzz.getBuzzAccount.invalidate();
          queryUtils.orchestrator.queryGeneratedImages.invalidate();
        }
        setStatus('connected');
      },
      onReconnecting: () => {
        console.debug('signal service reconnecting');
        setStatus('reconnecting');
      },
      onClosed: (message) => {
        // A closed connection will not recover on its own.
        console.debug({ type: 'SignalsProvider :: signal service closed', message }); // eslint-disable-line no-console
        queryUtils.signals.getToken.invalidate();
        setStatus('closed');
      },
      onError: (message) => {
        setStatus('error');
        console.error({ type: 'SignalsProvider :: signal service error', message });
      },
    });
  const { data } = trpc.signals.getToken.useQuery(undefined, {
    enabled: !!session.data?.user,
  });

  const accessToken = data?.accessToken;
  const userId = session.data?.user?.id;

  useEffect(() => {
    if (!accessToken) return;
    workerRef.current?.init(accessToken);
  }, [accessToken]); //eslint-disable-line

  const interval = useInterval(() => {
    if (!accessToken) return;
    console.log('attempting to reconnect signal services');
    workerRef.current?.init(accessToken);
  }, 30 * 1000);

  useEffect(() => {
    if (!status || status === 'connected') interval.stop();
    else interval.start();
  }, [status]);

  // useEffect(() => {
  //   const status = 'closed';
  //   if (status && status !== 'connected') {
  //     showNotification({
  //       id: 'signals-status',
  //       title: 'Connection error',
  //       message: 'test',
  //       color: signalStatusDictionary[status],
  //       autoClose: false,
  //     });
  //   } else hideNotification('signals-status');
  // }, [status]);

  return (
    <SignalContext.Provider
      value={{
        connected: status === 'connected',
        connectionError: status === 'error',
        reconnecting: status === 'reconnecting',
        closed: status === 'closed',
        status,
        worker: workerRef.current,
      }}
    >
      <SignalNotifications />
      <SignalsRegistrar />
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
  const { status } = useSignalContext();
  if (!status || status === 'connected') return null;

  return (
    <Notification
      {...notificationProps}
      // onClose={dismiss}
      color={signalStatusDictionary[status]}
      title={title?.(status)}
      disallowClose
    >
      {children(status)}
    </Notification>
  );
}
