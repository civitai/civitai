import React, { createContext, useContext, useState } from 'react';
import type { UserSettingsSchema } from '~/server/schema/user.schema';
import type { RegionInfo } from '~/server/utils/region-blocking';
import { trpc } from '~/utils/trpc';

type AppContext = {
  seed: number;
  canIndex: boolean;
  region: RegionInfo;
  allowMatureContent: boolean;
};
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
}: { children: React.ReactNode; settings: UserSettingsSchema; region: RegionInfo } & AppContext) {
  trpc.user.getSettings.useQuery(undefined, { initialData: settings });
  const [state] = useState(appContext);

  return <Context.Provider value={state}>{children}</Context.Provider>;
}
