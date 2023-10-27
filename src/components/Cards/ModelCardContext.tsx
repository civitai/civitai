import { createContext, useContext, ReactNode } from 'react';

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
  ...args
}: Context & { children: ReactNode }) => {
  return <ModelCardContext.Provider value={args}>{children}</ModelCardContext.Provider>;
};
