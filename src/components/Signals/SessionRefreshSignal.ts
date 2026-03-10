import { useCallback, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';

type SessionRefreshSignalData = {
  type: 'refresh' | 'invalid';
};

export const useSessionRefreshSignal = () => {
  const { update } = useSession();
  const updateRef = useRef(update);
  updateRef.current = update;

  const onSessionRefresh = useCallback((data: SessionRefreshSignalData) => {
    // Trigger session refresh - this will update the client's session cookie
    // with fresh user data from the server
    updateRef.current?.();
  }, []);

  useSignalConnection(SignalMessages.SessionRefresh, onSessionRefresh);
};
