import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';

type Context = {
  useModelVersionRedirect?: boolean;
  activeBaseModels?: string[];
};

const ModelCardContext = createContext<Context | null>(null);

export const useModelCardContext = () => {
  const context = useContext(ModelCardContext);
  return context ?? {};
};
export const ModelCardContextProvider = ({
  children,
  useModelVersionRedirect,
  activeBaseModels,
}: Context & { children: ReactNode }) => {
  const value = useMemo(
    () => ({ useModelVersionRedirect, activeBaseModels }),
    [useModelVersionRedirect, activeBaseModels]
  );
  return <ModelCardContext.Provider value={value}>{children}</ModelCardContext.Provider>;
};
