import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { trpc } from '~/utils/trpc';
import { SignalMessages } from '~/server/common/enums';
import { useSession } from 'next-auth/react';
import { BuzzUpdateSignalSchema } from '~/server/schema/signals.schema';
import { SignalNotifications } from '~/components/Signals/SignalsNotifications';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { SignalsRegistrar } from '~/components/Signals/SignalsRegistrar';
import { SignalWorker, createSignalWorker } from '~/utils/signals';

type SignalState = {
  connected: boolean;
  worker: React.RefObject<SignalWorker | null>;
};

const SignalContext = createContext<SignalState | null>(null);
export const useSignalContext = () => {
  const context = useContext(SignalContext);
  if (!context) throw new Error('SignalContext not in tree');
  return context;
};

// Add possible types to this data structure. Leave any for safeguarding.
type SignalCallback = (data: BuzzUpdateSignalSchema | any) => void;

export const useSignalConnection = (message: SignalMessages, cb: SignalCallback) => {
  const { connected, worker } = useSignalContext();

  useEffect(() => {
    const signalWorker = worker.current;
    if (connected && signalWorker) {
      signalWorker.on(message, cb);
    }

    return () => {
      signalWorker?.off(message, cb);
    };
  }, [connected]);
};

function FakeSignalProvider({ children }: { children: React.ReactNode }) {
  const workerRef = useRef<SignalWorker | null>(null);
  const [connected] = useState(false);
  return (
    <SignalContext.Provider
      value={{
        connected,
        worker: workerRef,
      }}
    >
      <SignalNotifications />
      {children}
    </SignalContext.Provider>
  );
}

function RealSignalProvider({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const firstRunRef = useRef(true);
  const workerRef = useRef<SignalWorker | null>(null);
  const [connected, setConnected] = useState(false);
  const { data } = trpc.signals.getAccessToken.useQuery(undefined, {
    enabled: !!session.data?.user,
  });

  useEffect(() => {
    if (!workerRef.current && data?.accessToken && firstRunRef.current) {
      firstRunRef.current = false;
      createSignalWorker({
        token: data.accessToken,
        onConnected: () => setConnected(true),
        onClosed: (message) => setConnected(false),
      }).then((worker) => {
        workerRef.current = worker;
      });
    }
    return () => workerRef.current?.unload();
  }, [data?.accessToken]);

  return (
    <SignalContext.Provider
      value={{
        connected,
        worker: workerRef,
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
