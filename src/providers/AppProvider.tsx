import React, { createContext, useContext } from 'react';
import { UserSettingsSchema } from '~/server/schema/user.schema';
import { trpc } from '~/utils/trpc';

type AppContext = { seed: number; canIndex: boolean };
const Context = createContext<AppContext | null>(null);
export function useAppContext() {
  const context = useContext(Context);
  if (!context) throw new Error('missing AppProvider in tree');
  return context;
}
export function AppProvider({
  children,
  settings,
  ...appContext
}: { children: React.ReactNode; settings: UserSettingsSchema } & AppContext) {
  trpc.user.getSettings.useQuery(undefined, { initialData: settings });

  return <Context.Provider value={appContext}>{children}</Context.Provider>;
}
