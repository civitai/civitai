import React, { createContext, useContext, useEffect, useState } from 'react';

type AppContext = { seed: number };
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
  const [seed, setSeed] = useState(appContext.seed);

  useEffect(() => {
    if (!seed && appContext.seed) setSeed(appContext.seed);
  }, []);

  return <Context.Provider value={{ seed }}>{children}</Context.Provider>;
}
