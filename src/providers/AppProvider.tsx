import React, { createContext, useContext, useState } from 'react';
import type { RegionInfo } from '~/server/utils/region-blocking';

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
  ...appContext
}: { children: React.ReactNode; region: RegionInfo } & AppContext) {
  const [state] = useState(appContext);

  return <Context.Provider value={state}>{children}</Context.Provider>;
}
