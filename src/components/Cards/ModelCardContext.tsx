import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';

type Context = {
  useModelVersionRedirect?: boolean;
};

const ModelCardContext = createContext<Context | null>(null);

export const useModelCardContext = () => {
  const context = useContext(ModelCardContext);
  return context ?? {};
};
export const ModelCardContextProvider = ({
  children,
  useModelVersionRedirect,
}: Context & { children: ReactNode }) => {
  const value = useMemo(() => ({ useModelVersionRedirect }), [useModelVersionRedirect]);
  return <ModelCardContext.Provider value={value}>{children}</ModelCardContext.Provider>;
};
