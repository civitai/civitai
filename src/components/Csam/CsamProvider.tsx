import { createContext, useContext } from 'react';
import { SimpleUser } from '~/server/selectors/user.selector';

type CsamState = {
  isInternal: boolean;
  userId: number;
  user?: SimpleUser;
};
const CsamContext = createContext<CsamState | null>(null);
export const useCsamContext = () => {
  const context = useContext(CsamContext);
  if (!context) throw new Error('missing Csam Provider');
  return context;
};

export function CsamProvider({ children, user }: { children: React.ReactNode; user: SimpleUser }) {
  const isInternal = user.id === -1;

  return (
    <CsamContext.Provider value={{ userId: user.id, isInternal, user }}>
      {children}
    </CsamContext.Provider>
  );
}
