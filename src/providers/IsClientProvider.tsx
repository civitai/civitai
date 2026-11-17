import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';

const IsClientContext = createContext<boolean | null>(null);

const noopSubscribe = () => () => undefined;

/**
 * `false` on the server and during hydration, `true` after. With no provider above it, it falls
 * back to the same hydration-safe client read instead of throwing.
 */
export const useIsClient = () => {
  const context = useContext(IsClientContext);
  const renderedOnClient = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
  return context ?? renderedOnClient;
};
export const IsClientProvider = ({ children }: { children: React.ReactNode }) => {
  const [isClient, setClient] = useState(false);

  useEffect(() => {
    setClient(true);
  }, []);

  return <IsClientContext.Provider value={isClient}>{children}</IsClientContext.Provider>;
};
