import { createContext, useContext } from 'react';

type CsamState = {
  isInternal: boolean;
  userId: number;
};
const CsamContext = createContext<CsamState | null>(null);
export const useCsamContext = () => {
  const context = useContext(CsamContext);
  if (!context) throw new Error('missing Csam Provider');
  return context;
};

export function CsamProvider({ children, userId }: { children: React.ReactNode; userId: number }) {
  const isInternal = userId === -1;

  return <CsamContext.Provider value={{ userId, isInternal }}>{children}</CsamContext.Provider>;
}
