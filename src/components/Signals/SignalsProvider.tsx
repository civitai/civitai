import { HubConnectionBuilder, HubConnection, HttpTransportType } from '@microsoft/signalr';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { trpc } from '~/utils/trpc';
import { SignalMessages } from '~/server/common/enums';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { env } from '~/env/client.mjs';
import { useSession } from 'next-auth/react';
import { BuzzUpdateSignalSchema } from '~/server/schema/signals.schema';
import { SignalNotifications } from '~/components/Signals/SignalsNotifications';

type SignalState = {
  connected: boolean;
  connection: React.RefObject<HubConnection | null>;
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
  const { connected, connection } = useSignalContext();

  useEffect(() => {
    if (connected && connection.current) {
      connection.current.on(message, cb);
    }

    const active = connection.current;

    return () => {
      if (!active) {
        return;
      }

      active.off(message, cb);
    };
  }, [connected]);
};

function FakeSignalProvider({ children }: { children: React.ReactNode }) {
  const connection = useRef<HubConnection | null>(null);
  const [connected, setConnected] = useState(false);
  return (
    <SignalContext.Provider
      value={{
        connected,
        connection,
      }}
    >
      <SignalNotifications />
      {children}
    </SignalContext.Provider>
  );
}

export function SignalProvider({ children }: { children: React.ReactNode }) {
  return FakeSignalProvider({ children });

  const session = useSession();
  const [connected, setConnected] = useState(false);
  const { data } = trpc.signals.getAccessToken.useQuery(undefined, {
    enabled: !!session.data?.user,
  });
  const connection = useRef<HubConnection | null>(null);

  const getConnection = async () => {
    if (connection.current) return connection.current;
    if (!data?.accessToken) return null;

    const signalRConnection = new HubConnectionBuilder()
      .withUrl(`${env.NEXT_PUBLIC_SIGNALS_ENDPOINT}/hub`, {
        accessTokenFactory: () => data.accessToken, // Set the access token for the connection
        skipNegotiation: true,
        transport: HttpTransportType.WebSockets,
      })
      .withAutomaticReconnect() // Enable automatic retry
      .build();

    try {
      await signalRConnection.start();
      setConnected(true);

      signalRConnection.onclose(() => {
        setConnected(false);
      });

      signalRConnection.onreconnected(() => {
        setConnected(true);
      });

      connection.current = signalRConnection;
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    if (data?.accessToken) {
      getConnection();
    }
  }, [data?.accessToken]);

  return (
    <SignalContext.Provider
      value={{
        connected,
        connection,
      }}
    >
      <SignalNotifications />
      {children}
    </SignalContext.Provider>
  );
}
