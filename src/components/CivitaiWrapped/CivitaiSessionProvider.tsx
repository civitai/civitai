import { Session } from 'next-auth';
import { SessionUser } from 'next-auth';
import { useSession } from 'next-auth/react';
import { createContext, useContext, useMemo } from 'react';
import { extendedSessionUser } from '~/utils/session-helpers';

export type CivitaiSessionState = SessionUser & {
  refresh: () => Promise<Session | null>;
};
const CivitaiSessionContext = createContext<CivitaiSessionState | null>(null);
export const useCivitaiSessionContext = () => useContext(CivitaiSessionContext);

export let isAuthed = false;
// export let isIdentified = false;
export function CivitaiSessionProvider({ children }: { children: React.ReactNode }) {
  const { data, update } = useSession();

  const value = useMemo(() => {
    if (!data?.user) return null;
    isAuthed = true;

    return {
      ...extendedSessionUser(data.user),
      refresh: update,
    };
  }, [data?.user, update]);

  return <CivitaiSessionContext.Provider value={value}>{children}</CivitaiSessionContext.Provider>;
}
