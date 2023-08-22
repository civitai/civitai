import { SessionUser } from 'next-auth';
import { useSession } from 'next-auth/react';
import { createContext, useContext, useMemo } from 'react';
import posthog from 'posthog-js';

type CivitaiSessionState = SessionUser & { isMember: boolean; refresh: () => void };
const CivitaiSessionContext = createContext<CivitaiSessionState | null>(null);
export const useCivitaiSessionContext = () => useContext(CivitaiSessionContext);

export let isAuthed = false;
// export let isIdentified = false;
export function CivitaiSessionProvider({ children }: { children: React.ReactNode }) {
  const { data, update } = useSession();

  const value = useMemo(() => {
    if (!data?.user) return null;
    isAuthed = true;
    // TODO: PostHog - enable when we're ready
    // if (typeof window !== 'undefined' && !isIdentified) {
    //   posthog?.identify(data.user.id + '', {
    //     name: data.user.username,
    //     email: data.user.email,
    //   });
    //   isIdentified = true;
    // }
    return {
      ...data.user,
      isMember: data.user.tier != null,
      refresh: update,
    };
  }, [data?.user, update]);

  return <CivitaiSessionContext.Provider value={value}>{children}</CivitaiSessionContext.Provider>;
}

// export const reloadSession = async () => {
//   await fetch('/api/auth/session?update');
//   const event = new Event('visibilitychange');
//   document.dispatchEvent(event);
// };
