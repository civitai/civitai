import { SessionUser } from 'next-auth';
import { useSession } from 'next-auth/react';
import { createContext, useContext, useEffect, useMemo } from 'react';
import { trpc } from '~/utils/trpc';

type CivitaiSessionState = SessionUser & { isMember: boolean; refresh: () => void };
const CivitaiSessionContext = createContext<CivitaiSessionState | null>(null);
export const useCivitaiSessionContext = () => useContext(CivitaiSessionContext);
export const useCurrentUser = useCivitaiSessionContext;

export let isAuthed = false;
export function CivitaiSessionProvider({ children }: { children: React.ReactNode }) {
  const { data, update } = useSession();

  const value = useMemo(() => {
    if (!data?.user) return null;
    isAuthed = true;
    return {
      ...data.user,
      isMember: data.user.tier != null,
      refresh: update,
    };
  }, [data?.user, update]);

  const queryUtils = trpc.useContext();
  useEffect(() => {
    queryUtils.user.getHiddenPreferences.invalidate({ type: 'tags' });
  }, [value?.showNsfw]); //eslint-disable-line

  return <CivitaiSessionContext.Provider value={value}>{children}</CivitaiSessionContext.Provider>;
}

// export const reloadSession = async () => {
//   await fetch('/api/auth/session?update');
//   const event = new Event('visibilitychange');
//   document.dispatchEvent(event);
// };
