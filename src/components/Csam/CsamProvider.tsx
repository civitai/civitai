import type { CsamReportType } from '~/shared/utils/prisma/enums';
import { createContext, useContext } from 'react';
import type { SimpleUser } from '~/server/selectors/user.selector';

type CsamState = {
  isInternal: boolean;
  userId: number;
  user?: SimpleUser;
  type: CsamReportType;
};
const CsamContext = createContext<CsamState | null>(null);
export const useCsamContext = () => {
  const context = useContext(CsamContext);
  if (!context) throw new Error('missing Csam Provider');
  return context;
};

export function CsamProvider({
  children,
  user,
  type,
}: {
  children: React.ReactNode;
  user: SimpleUser;
  type: CsamReportType;
}) {
  const isInternal = user.id === -1;

  return (
    <CsamContext.Provider value={{ userId: user.id, isInternal, user, type }}>
      {children}
    </CsamContext.Provider>
  );
}
