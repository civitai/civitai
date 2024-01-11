import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
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
  const accessToken = data?.accessToken;
  const userId = session.data?.user?.id;
  const connectingRef = useRef(false);

  const createWorker = useCallback(
    (accessToken: string) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      createSignalWorker({
        token: accessToken,
        onConnected: () => {
          console.debug('SignalsProvider :: signal service connected'); // eslint-disable-line no-console
          setConnected(true);
          connectingRef.current = false;
        },
        onReconnected: () => {
          console.debug('signal service reconnected'); // eslint-disable-line no-console
          if (userId) {
            queryUtils.buzz.getBuzzAccount.invalidate();
          }
        },
        onClosed: (message) => {
          // A closed connection will not recover on its own.
          console.debug({ type: 'SignalsProvider :: signal service closed', message }); // eslint-disable-line no-console
          setConnected(false);
          queryUtils.signals.getAccessToken.invalidate();
        },
        onError: (message) =>
          console.error({ type: 'SignalsProvider :: signal service error', message }),
      }).then((worker) => {
        setWorker(worker);
        loadingRef.current = false;
        connectingRef.current = true;
      });
    },
    [userId]
  );

  useEffect(() => {
    if (!accessToken) return;
    if (!worker) createWorker(accessToken);
    // this should cause the effect to run the timeout when the access token changes
    else if (!connected && !connectingRef.current) {
      worker.close();
      const timeout = setTimeout(() => {
        console.debug('SignalsProvider :: attempting to re-create the connection...');
        createWorker(accessToken);
      }, 5000);
      return () => clearTimeout(timeout);
    }
  }, [accessToken, createWorker, worker]);

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
