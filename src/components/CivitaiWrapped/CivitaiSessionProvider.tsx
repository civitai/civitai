import { SessionUser } from 'next-auth';
import { useSession } from 'next-auth/react';
import { createContext, useContext, useMemo } from 'react';
import { trpc } from '~/utils/trpc';

type CivitaiSessionState = SessionUser & { isMember: boolean; refresh: () => void };
const CivitaiSessionContext = createContext<CivitaiSessionState | null>(null);
export const useCivitaiSessionContext = () => useContext(CivitaiSessionContext);

export let isAuthed = false;
export function CivitaiSessionProvider({ children }: { children: React.ReactNode }) {
  const { data, update } = useSession();
  const { balance = 0 } = useQueryBuzzAccount({ enabled: !!data?.user });

  const value = useMemo(() => {
    if (!data?.user) return null;
    isAuthed = true;
    return {
      ...data.user,
      isMember: data.user.tier != null,
      refresh: update,
      balance,
    };
  }, [balance, data?.user, update]);

  return <CivitaiSessionContext.Provider value={value}>{children}</CivitaiSessionContext.Provider>;
}

// export const reloadSession = async () => {
//   await fetch('/api/auth/session?update');
//   const event = new Event('visibilitychange');
//   document.dispatchEvent(event);
// };

type QueryOptions = { enabled?: boolean };
export const useQueryBuzzAccount = (options?: QueryOptions) => {
  const { data } = trpc.buzz.getUserAccount.useQuery(undefined, options);

  return data ?? { balance: 0 };
};
