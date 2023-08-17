import signalR from '@microsoft/signalr';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { trpc } from '~/utils/trpc';
import { SignalMessages } from '~/server/common/enums';

type SignalState = {
  connected: boolean;
};

const SignalContext = createContext<SignalState | null>(null);
export const useSignalContext = () => {
  const context = useContext(SignalContext);
  if (!context) throw new Error('SignalContext not in tree');
  return context;
};

export function SignalProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const { data } = trpc.signals.getAccessToken.useQuery();
  const connection = useRef<signalR.HubConnection | null>(null);

  const getConnection = async () => {
    if (connection.current) return connection.current;
    if (!data?.accessToken) return null;

    const signalRConnection = new signalR.HubConnectionBuilder()
      .withUrl('/hub', {
        accessTokenFactory: () => data.accessToken, // Set the access token for the connection
      })
      .withAutomaticReconnect() // Enable automatic retry
      .build();

    try {
      await signalRConnection.start();
      setConnected(true);

      signalRConnection.on(SignalMessages.BuzzUpdate, (data) => {
        console.log(data);
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
      }}
    >
      {children}
    </SignalContext.Provider>
  );
}
