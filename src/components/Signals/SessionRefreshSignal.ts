import { useCallback, useRef } from 'react';
import { useSession } from '~/providers/SessionProvider';
import { handleSignOut } from '~/utils/auth-helpers';
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
    // 'invalid' means the server has revoked this session (delete account, ban, etc.).
    // update() would re-issue a fresh JWT cookie and clear the Redis 'invalid' marker,
    // leaving the user logged in. Force a signOut instead.
    if (data?.type === 'invalid') {
      handleSignOut();
      return;
    }
    // 'refresh' (or unknown): pull fresh session data into the client cookie.
    updateRef.current?.();
  }, []);

  useSignalConnection(SignalMessages.SessionRefresh, onSessionRefresh);
};
