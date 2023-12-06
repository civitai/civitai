import { useIsomorphicEffect } from '@mantine/hooks';
import { createContext, useContext, useEffect, useState } from 'react';

const IsClientContext = createContext<boolean | null>(null);
export const useIsClient = () => {
  const context = useContext(IsClientContext);
  if (context === null) throw new Error('missing IsClientContext');
  return context;
};
export const IsClientProvider = ({ children }: { children: React.ReactNode }) => {
  const [isClient, setClient] = useState(false);

  useIsomorphicEffect(() => {
    setClient(true);
  }, []);

  return <IsClientContext.Provider value={isClient}>{children}</IsClientContext.Provider>;
};
