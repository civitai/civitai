import React, { createContext, useContext } from 'react';

type AppContext = { seed: number; canIndex: boolean };
const Context = createContext<AppContext | null>(null);
export function useAppContext() {
  const context = useContext(Context);
  if (!context) throw new Error('missing AppProvider in tree');
  return context;
}
export function AppProvider({
  children,
  ...appContext
}: { children: React.ReactNode } & AppContext) {
  return <Context.Provider value={appContext}>{children}</Context.Provider>;
}
