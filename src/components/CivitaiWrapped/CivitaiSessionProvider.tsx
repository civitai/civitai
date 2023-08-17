import { SessionUser } from 'next-auth';
import { useSession } from 'next-auth/react';
import { createContext, useCallback, useContext, useMemo } from 'react';
import { trpc } from '~/utils/trpc';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { BuzzUpdateSignalSchema } from '~/server/schema/signals.schema';

export type CivitaiSessionState = SessionUser & {
  isMember: boolean;
  refresh: () => void;
  balance: number;
};
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
  const queryUtils = trpc.useContext();

  const onBalanceUpdate = useCallback(
    (updated: BuzzUpdateSignalSchema) => {
      queryUtils.buzz.getUserAccount.setData(undefined, (old) => {
        if (!old) return old;
        return { ...old, balance: updated.balance };
      });
    },
    [queryUtils]
  );

  useSignalConnection(SignalMessages.BuzzUpdate, onBalanceUpdate);

  return data ?? { balance: 0 };
};
