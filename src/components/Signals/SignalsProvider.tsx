import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { trpc } from '~/utils/trpc';
import { SignalMessages } from '~/server/common/enums';
import { useSession } from 'next-auth/react';
import { SignalNotifications } from '~/components/Signals/SignalsNotifications';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { SignalsRegistrar } from '~/components/Signals/SignalsRegistrar';
import { SignalWorker, createSignalWorker } from '~/utils/signals';

type SignalState = {
  connected: boolean;
  worker: SignalWorker | null;
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

function FakeSignalProvider({ children }: { children: React.ReactNode }) {
  const [worker] = useState<SignalWorker | null>(null);
  const [connected] = useState(false);
  return (
    <SignalContext.Provider
      value={{
        connected,
        worker,
      }}
    >
      <SignalNotifications />
      {children}
    </SignalContext.Provider>
  );
}

function RealSignalProvider({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const loadingRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [worker, setWorker] = useState<SignalWorker | null>(null);
  const { data } = trpc.signals.getAccessToken.useQuery(undefined, {
    enabled: !!session.data?.user,
  });
  const queryUtils = trpc.useContext();

  useEffect(() => {
    const createWorker = () => {
      if (!data || loadingRef.current) {
        return;
      }
      loadingRef.current = true;
      createSignalWorker({
        token: data.accessToken,
        onConnected: () => {
          console.debug('SignalsProvider :: signal service connected'); // eslint-disable-line no-console
          setConnected(true);
        },
        onReconnected: () => {
          console.debug('signal service reconnected'); // eslint-disable-line no-console
          if (session.data?.user?.id) {
            queryUtils.buzz.getBuzzAccount.invalidate();
          }
        },
        onClosed: (message) => {
          // A closed connection will not recover on its own.
          console.debug({ type: 'SignalsProvider :: signal service closed', message }); // eslint-disable-line no-console
          setConnected(false);

          setTimeout(() => {
            console.debug('SignalsProvider :: attempting to re-crate the connection...'); // eslint-disable-line no-console
            createWorker();
          }, 5000);
        },
        onError: (message) =>
          console.error({ type: 'SignalsProvider :: signal service error', message }),
      }).then((worker) => {
        setWorker(worker);
        loadingRef.current = false;
        worker.subscribe(({ available }) => {
          if (!available) {
            setWorker(null);
            worker.close();
            createWorker();
          }
        });
      });
    };

    if (data?.accessToken) createWorker();

    return () => worker?.close();
  }, [data?.accessToken]);

  return (
    <SignalContext.Provider
      value={{
        connected,
        worker,
      }}
    >
      <SignalNotifications />
      <SignalsRegistrar />
      {children}
    </SignalContext.Provider>
  );
}

export function SignalProvider({ children }: { children: React.ReactNode }) {
  const features = useFeatureFlags();
  if (!features.signal) return FakeSignalProvider({ children });
  else return RealSignalProvider({ children });
}
