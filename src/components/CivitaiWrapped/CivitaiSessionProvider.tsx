import { Session } from 'next-auth';
import { SessionContext, SessionProvider, SessionProviderProps } from 'next-auth/react';
import { useMemo } from 'react';

export let isAuthed = false;
export function CivitaiSessionProvider({ children, session }: SessionProviderProps) {
  if (session?.user) {
    isAuthed = true;
    return (
      <SessionProvider session={session} refetchOnWindowFocus={false} refetchWhenOffline={false}>
        {children}
      </SessionProvider>
    );
  } else {
    return <CivitaiDummySession>{children}</CivitaiDummySession>;
  }
}

function CivitaiDummySession({ children }: { children: React.ReactNode }) {
  const value: any = useMemo(
    () => ({
      data: {},
      status: 'unauthenticated',
      update: async () => ({} as Session),
    }),
    []
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
